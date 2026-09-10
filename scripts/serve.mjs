import { createServer } from 'node:http';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const configuredRoot = process.env.SERVE_ROOT
  ? path.resolve(projectRoot, process.env.SERVE_ROOT)
  : projectRoot;
const port = Number(process.env.PORT ?? 4173);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be an integer between 1 and 65535 (received ${process.env.PORT})`);
}

function insideRoot(candidate) {
  const relative = path.relative(configuredRoot, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function mimeType(filePath) {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp'
  };
  return types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function decodedPath(requestURL) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestURL.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const segments = pathname.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) return null;
  return segments;
}

function hasTraversal(rawTarget) {
  const rawPath = rawTarget.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes('\0')
    || decoded.includes('\\')
    || decoded.split('/').some(segment => segment === '..');
}

async function resolveRequest(segments, allowRootFallback) {
  const cleanSegments = segments.filter(Boolean);
  const candidates = [];
  for (let offset = 0; offset <= cleanSegments.length; offset += 1) {
    const relativePath = cleanSegments.slice(offset).join(path.sep);
    if (relativePath || allowRootFallback) candidates.push(relativePath);
  }

  for (const relativePath of candidates) {
    const candidate = path.resolve(configuredRoot, relativePath);
    if (!insideRoot(candidate)) continue;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const index = path.join(candidate, 'index.html');
        if (insideRoot(index)) {
          const indexInfo = await lstat(index).catch(() => null);
          if (indexInfo?.isFile()) return index;
        }
      } else if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next subpath candidate. A missing leading deployment segment
      // is expected when testing a static app at /LoughdIn/ locally.
    }
  }
  return null;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  if (hasTraversal(request.url ?? '/')) {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  let requestURL;
  try {
    requestURL = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  const segments = decodedPath(requestURL);
  if (!segments) {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  const filePath = await resolveRequest(segments, requestURL.pathname.endsWith('/'));
  if (!filePath) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const headers = { 'content-type': mimeType(filePath) };
  if (request.method === 'HEAD') {
    response.writeHead(200, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  const { createReadStream } = await import('node:fs');
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Lough'd In serving ${configuredRoot} at http://localhost:${port}/`);
});
