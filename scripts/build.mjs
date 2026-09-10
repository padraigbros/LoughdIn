import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = path.resolve(projectRoot, 'dist');

// Keep the publish surface explicit. Source snapshots, documentation, local
// configuration and repository metadata must never enter the Pages artifact.
const rootFiles = ['index.html', 'manifest.json', 'sw.js'];
const recursiveRoots = ['icons', 'src', 'styles', 'vendor'];
const requiredSourceFiles = ['src/planner.js'];
const excludedName = /(^|[._-])(env|secret|secrets|credentials?|token|snapshot)([._-]|$)|\.(?:md|markdown|map)$/i;

function pathWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes its root: ${candidate}`);
  }
  return candidate;
}

function sourcePath(relativePath) {
  return pathWithin(projectRoot, path.resolve(projectRoot, relativePath), 'source');
}

function outputPath(relativePath) {
  return pathWithin(distRoot, path.resolve(distRoot, relativePath), 'output');
}

function shouldPublish(relativePath) {
  return !relativePath.split(path.sep).some(part => excludedName.test(part));
}

async function copyRootFile(relativePath) {
  if (!shouldPublish(relativePath)) return;
  const source = sourcePath(relativePath);
  const destination = outputPath(relativePath);
  const info = await lstat(source);
  if (!info.isFile()) throw new Error(`Publish entry is not a regular file: ${relativePath}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyTree(relativeRoot) {
  const sourceRoot = sourcePath(relativeRoot);
  const rootInfo = await lstat(sourceRoot);
  if (!rootInfo.isDirectory()) throw new Error(`Publish root is not a directory: ${relativeRoot}`);

  async function visit(relativePath) {
    if (!shouldPublish(relativePath)) return;
    const source = sourcePath(relativePath);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the publish tree: ${relativePath}`);

    if (info.isDirectory()) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        await visit(path.join(relativePath, entry.name));
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported publish entry: ${relativePath}`);

    const destination = outputPath(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await visit(relativeRoot);
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

for (const file of requiredSourceFiles) await lstat(sourcePath(file));
for (const file of rootFiles) await copyRootFile(file);
for (const directory of recursiveRoots) await copyTree(directory);

// A new shell changes the worker bytes, so clients receive an explicit update.
const hash = createHash('sha256');
async function hashTree(directory) {
  const entries=(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){const full=path.join(directory,entry.name);if(entry.isDirectory())await hashTree(full);else if(full!==path.join(distRoot,'sw.js')){hash.update(path.relative(distRoot,full));hash.update(await readFile(full));}}
}
await hashTree(distRoot);
const workerPath=path.join(distRoot,'sw.js');
const worker=await readFile(workerPath,'utf8');
await writeFile(workerPath,worker.replace("const CACHE_VERSION = 'v1';","const CACHE_VERSION = '"+hash.digest('hex').slice(0,16)+"';"));
console.log('Built '+distRoot);
