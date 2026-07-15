const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const packOutput = execFileSync('npm', ['pack', '--json', '--dry-run=false'], {
  cwd: root,
  encoding: 'utf8',
});
const [pack] = JSON.parse(packOutput);
assert.ok(pack.filename, 'npm pack returned a tarball filename');

const tarball = path.join(root, pack.filename);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webframe-pack-'));

try {
  execFileSync('npm', ['init', '-y'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: tempDir,
    stdio: 'inherit',
  });

  const installedRoot = path.join(tempDir, 'node_modules/@samdesota/webframe');
  const pkg = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));

  assert.equal(pkg.name, '@samdesota/webframe');
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './renderer', './sqlite']);
  assert.equal(pkg.peerDependencies.electron, '>=42');
  assert.equal(pkg.peerDependenciesMeta['better-sqlite3'].optional, true);

  for (const relativePath of [
    'dist/index.js',
    'dist/renderer.js',
    'sqlite/dist/index.js',
    'dist/index.d.ts',
    'dist/renderer.d.ts',
    'sqlite/dist/index.d.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(installedRoot, relativePath)), `${relativePath} is packed`);
  }

  console.log('local pack install smoke test passed');
} finally {
  fs.rmSync(tarball, { force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
}
