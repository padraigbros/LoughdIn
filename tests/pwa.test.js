import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => readFileSync(join(appRoot, file), 'utf8');

test('manifest uses paths relative to its deployment subpath', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.deepEqual(
    manifest.icons.map(icon => icon.src),
    ['./icons/icon-192.png', './icons/icon-512.png']
  );

  const deployedBase = new URL('https://example.test/LoughdIn/');
  assert.equal(new URL(manifest.start_url, deployedBase).pathname, '/LoughdIn/');
  for (const icon of manifest.icons) {
    assert.equal(new URL(icon.src, deployedBase).pathname.startsWith('/LoughdIn/'), true);
  }
});
test('service worker precaches the complete app shell and owns only its scope caches', () => {
  const worker = read('sw.js');
  for (const shellFile of [
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './src/app.js',
    './src/timer.js',
    './src/storage.js',
    './src/sync.js',
    './src/scenes.js',
    './src/planner.js',
    './src/config.js',
    './src/native.js',
    './vendor/supabase.js',
    './styles/enhancements.css'
  ]) {
    assert.match(worker, new RegExp(`['"]${shellFile.replaceAll('.', '\\.') }['"]`));
  }
  assert.match(worker, /self\.registration\.scope/);
  assert.match(worker, /key\.startsWith\(OWN_CACHE_PREFIX\)/);
  assert.doesNotMatch(worker, /keys\.filter\(key => key !== CACHE_NAME\)/);
  assert.match(worker, /event\.data\?\.type === ['"]SKIP_WAITING['"]/);
  assert.doesNotMatch(worker, /install[\s\S]{0,300}self\.skipWaiting\(\)/);
  assert.match(worker, /requestURL\.origin !== self\.location\.origin/);
});
function filesUnder(directory, baseDirectory = directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(fullPath, baseDirectory));
    else result.push(relative(baseDirectory, fullPath));
  }
  return result;
}

test('build emits only the explicitly publishable app tree', () => {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: appRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const distRoot = join(appRoot, 'dist');
  for (const shellFile of [
    'index.html',
    'manifest.json',
    'sw.js',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'src/app.js',
    'src/timer.js',
    'src/storage.js',
    'src/sync.js',
    'src/scenes.js',
    'src/planner.js',
    'src/config.js',
    'vendor/supabase.js',
    'vendor/native.js',
    'styles/enhancements.css'
  ]) {
    assert.equal(existsSync(join(distRoot, shellFile)), true, shellFile);
  }

  const published = filesUnder(distRoot).map(file => file.replaceAll('\\', '/'));
  for (const file of published) {
    assert.doesNotMatch(file, /(?:^|[./_-])(?:\.env|secret|credential|token|snapshot)(?:[./_-]|$)/i);
    assert.doesNotMatch(file, /\.(?:md|markdown|map)$/i);
    assert.ok(/^(?:index\.html|manifest\.json|sw\.js|(?:icons|src|styles|vendor)\/)/.test(file), file);
  }
});

