import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanForSecrets } from '../scripts/scan-public-config.mjs';

// Fixtures are assembled at runtime so no secret-shaped literal is committed.
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = role => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role })}.${'s'.repeat(43)}`;
const secretKey = 'sb_' + 'secret_' + 'Q7x2Lm9Pz4Kd8Wn3Rt6Yb1';

function scan(files) {
  const root = mkdtempSync(join(tmpdir(), 'loughdin-scan-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return scanForSecrets(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('public client configuration and library prefix checks pass', () => {
  assert.deepEqual(scan({
    'public/vendor/supabase.js': 'Ks=r=>r.startsWith("sb_publishable_")||r.startsWith("sb_secret_")',
    'public/src/config.js': "export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_WG2eOJN1zsQFQ9NR6euv4w_SS-zMP3-';",
    'public/legacy.js': `const anon = '${jwt('anon')}';`,
  }), []);
});

test('a Supabase secret key is reported with its file', () => {
  assert.deepEqual(scan({ 'public/src/config.js': `const key = '${secretKey}';` }),
    [{ file: 'public/src/config.js', kind: 'Supabase secret key' }]);
});

test('a service-role JWT is reported with its file', () => {
  assert.deepEqual(scan({ 'public/nested/app.js': `headers.apikey = "${jwt('service_role')}"` }),
    [{ file: 'public/nested/app.js', kind: 'service-role JWT' }]);
});
