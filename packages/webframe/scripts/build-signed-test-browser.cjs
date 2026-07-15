#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { signAsync } = require('@electron/osx-sign');

const repo = path.resolve(__dirname, '..');
const appName = process.env.WEBFRAME_TEST_BROWSER_NAME || 'WebFrame 1Password Test';
const bundleId = process.env.WEBFRAME_TEST_BROWSER_BUNDLE_ID || 'dev.webframe.onepassword-test-browser';
const sourceApp = path.join(repo, 'node_modules', 'electron', 'dist', 'Electron.app');
const buildDir = path.join(repo, 'tmp', 'signed-test-browser');
const stagedApp = path.join(buildDir, `${appName}.app`);
const installApp = process.env.WEBFRAME_TEST_BROWSER_INSTALL_PATH || path.join('/Applications', `${appName}.app`);
let identity;

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim() || result.stderr.trim();
}

function plist(plistPath, command) {
  return run('/usr/libexec/PlistBuddy', ['-c', command, plistPath]);
}

function setPlist(plistPath, key, value) {
  const escaped = String(value).replace(/"/g, '\\"');
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${escaped}`, plistPath], { encoding: 'utf8' });
  if (set.status === 0) return;
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${escaped}`, plistPath]);
}

function signingIdentities() {
  const output = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  return output.split('\n')
    .map((line) => /\)\s+([A-F0-9]{40})\s+"([^"]+)"/.exec(line))
    .filter(Boolean)
    .map((match) => ({ hash: match[1], name: match[2] }));
}

function defaultIdentity() {
  const requested = process.env.WEBFRAME_SIGN_IDENTITY;
  const identities = signingIdentities();
  if (requested) {
    const found = identities.find((identity) => identity.name.includes(requested) || identity.hash === requested);
    if (!found) throw new Error(`signing identity not found: ${requested}`);
    return found;
  }
  const developerId = identities.find((identity) => identity.name.startsWith('Developer ID Application:'));
  if (developerId) return developerId;
  const development = identities.find((identity) => identity.name.startsWith('Apple Development:'));
  if (development) return development;
  throw new Error('no Developer ID Application or Apple Development codesigning identity found');
}

function teamIdFromIdentity(identity) {
  return /\(([A-Z0-9]+)\)$/.exec(identity.name)?.[1];
}

function helperBundleId(helperName) {
  if (helperName.includes('(Renderer)')) return `${bundleId}.helper.Renderer`;
  if (helperName.includes('(GPU)')) return `${bundleId}.helper.GPU`;
  if (helperName.includes('(Plugin)')) return `${bundleId}.helper.Plugin`;
  return `${bundleId}.helper`;
}

function rewriteBundle() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.cpSync(sourceApp, stagedApp, { recursive: true, verbatimSymlinks: true });

  const contents = path.join(stagedApp, 'Contents');
  const mainPlist = path.join(contents, 'Info.plist');
  const oldExecutable = plist(mainPlist, 'Print :CFBundleExecutable');
  const oldExecutablePath = path.join(contents, 'MacOS', oldExecutable);
  const newExecutablePath = path.join(contents, 'MacOS', appName);
  if (oldExecutablePath !== newExecutablePath) fs.renameSync(oldExecutablePath, newExecutablePath);

  const teamId = teamIdFromIdentity(identity);
  setPlist(mainPlist, 'CFBundleIdentifier', bundleId);
  setPlist(mainPlist, 'CFBundleExecutable', appName);
  setPlist(mainPlist, 'CFBundleName', appName);
  setPlist(mainPlist, 'CFBundleDisplayName', appName);
  setPlist(mainPlist, 'CFBundleShortVersionString', '0.1.0');
  setPlist(mainPlist, 'CFBundleVersion', '1');
  if (teamId) setPlist(mainPlist, 'ElectronTeamID', teamId);

  const frameworks = path.join(contents, 'Frameworks');
  for (const entry of fs.readdirSync(frameworks)) {
    if (!entry.startsWith('Electron Helper') || !entry.endsWith('.app')) continue;
    const helperPath = path.join(frameworks, entry);
    const helperPlist = path.join(helperPath, 'Contents', 'Info.plist');
    const helperId = helperBundleId(entry);
    const helperDisplayName = entry.replace(/^Electron/, appName);
    setPlist(helperPlist, 'CFBundleIdentifier', helperId);
    setPlist(helperPlist, 'CFBundleName', helperDisplayName.replace(/\.app$/, ''));
    if (teamId) setPlist(helperPlist, 'ElectronTeamID', teamId);
  }
}

async function signBundle() {
  await signAsync({
    app: stagedApp,
    identity: identity.name,
    type: identity.name.startsWith('Apple Development:') ? 'development' : 'distribution',
    platform: 'darwin',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    strictVerify: false,
  });
}

function installBundle() {
  fs.rmSync(installApp, { recursive: true, force: true });
  fs.cpSync(stagedApp, installApp, { recursive: true, verbatimSymlinks: true });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('this harness only builds macOS .app bundles');
  if (!fs.existsSync(sourceApp)) throw new Error(`Electron.app not found: ${sourceApp}`);
  identity = defaultIdentity();
  console.error(`Using signing identity: ${identity.name}`);
  console.error(`Bundle ID: ${bundleId}`);
  console.error(`Staging: ${stagedApp}`);
  console.error(`Installing: ${installApp}`);
  rewriteBundle();
  await signBundle();
  installBundle();
  console.log(installApp);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
