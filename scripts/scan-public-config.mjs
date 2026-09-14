// Fail a build whose shipped files contain a Supabase secret. Only the
// publishable key may ship. The client library mentions the "sb_secret_"
// prefix itself, so match real key bodies and decode JWT role claims rather
// than searching for the bare words.
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{16,}/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{16,}/g;

function jwtRole(payload) {
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role; } catch { return undefined; }
}

export function scanForSecrets(root) {
  const findings = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const text = readFileSync(path, 'latin1');
      const file = relative(root, path).replaceAll('\\', '/');
      if (SECRET_KEY.test(text)) findings.push({file, kind: 'Supabase secret key'});
      for (const [, payload] of text.matchAll(JWT)) {
        if (jwtRole(payload) === 'service_role') findings.push({file, kind: 'service-role JWT'});
      }
    }
  };
  walk(root);
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2];
  if (!root) { console.error('Usage: node scripts/scan-public-config.mjs <directory>'); process.exit(2); }
  const findings = scanForSecrets(root);
  for (const {file, kind} of findings) console.error(`${kind} found in ${file}`);
  if (findings.length) process.exit(1);
  console.log(`No Supabase secrets in ${root}`);
}
