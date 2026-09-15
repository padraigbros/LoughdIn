import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

// Lough'd In ships no Facebook code in any form: no SDK, no disabled provider
// stubs, no bundled Facebook web login, and no multi-provider login plugins
// that carry one. The word is assembled so this file does not match itself.
const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FORBIDDEN = new RegExp(['face', 'book'].join(''), 'i');
const MULTI_PROVIDER_PLUGINS = /social-?login|capacitor-firebase\/authentication/i;

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (['node_modules', 'build', '.gradle', 'dist'].includes(name)) return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('no Facebook or multi-provider login package is a dependency', () => {
  const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(appRoot, 'package-lock.json'), 'utf8'));
  const names = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(lock.packages || {})];
  const offenders = names.filter(name => FORBIDDEN.test(name) || MULTI_PROVIDER_PLUGINS.test(name));
  assert.deepEqual(offenders, []);
});

test('no app source, config or Android project file mentions Facebook', () => {
  const files = [
    'index.html', 'privacy.html', 'manifest.json', 'sw.js', 'capacitor.config.json',
    ...filesUnder(join(appRoot, 'src')).map(f => relative(appRoot, f)),
    ...filesUnder(join(appRoot, 'styles')).map(f => relative(appRoot, f)),
    ...filesUnder(join(appRoot, 'android')).map(f => relative(appRoot, f)).filter(f => /\.(java|kt|kts|gradle|xml|json|properties)$/.test(f)),
  ].filter(f => existsSync(join(appRoot, f)));
  const offenders = files.filter(f => FORBIDDEN.test(readFileSync(join(appRoot, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the bundled native bridge carries no Facebook code', () => {
  const bundle = join(appRoot, 'vendor', 'native.js');
  assert.ok(existsSync(bundle), 'npm test builds vendor/native.js before running');
  assert.equal(FORBIDDEN.test(readFileSync(bundle, 'utf8')), false);
});
