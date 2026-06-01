#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appPath = process.argv[2] || '/Applications/Kaivo.app';
const expectedBundleId = process.env.KAIVO_BUNDLE_ID || 'com.samdesota.kaivo';

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...opts });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function plist(plistPath, key) {
  return execFileSync('/usr/libexec/PlistBuddy', [plistPath, '-c', `Print :${key}`], { encoding: 'utf8' }).trim();
}

function signature(appOrBinary) {
  const detail = run('codesign', ['-dv', '--verbose=4', appOrBinary]);
  const text = `${detail.stdout}\n${detail.stderr}`;
  return {
    authority: Array.from(text.matchAll(/^Authority=(.+)$/gm)).map((m) => m[1]),
    teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(text)?.[1],
    identifier: /^Identifier=(.+)$/m.exec(text)?.[1],
    raw: text,
  };
}

function helperReport(frameworkDir, name, expectedId) {
  const helperPath = path.join(frameworkDir, name);
  const plistPath = path.join(helperPath, 'Contents/Info.plist');
  const executable = plist(plistPath, 'CFBundleExecutable');
  const executablePath = path.join(helperPath, 'Contents/MacOS', executable);
  return {
    name,
    path: helperPath,
    bundleId: plist(plistPath, 'CFBundleIdentifier'),
    expectedBundleId: expectedId,
    verify: run('codesign', ['--verify', '--strict', helperPath]),
    signature: signature(executablePath),
  };
}

if (!fs.existsSync(appPath)) {
  console.error(`missing app: ${appPath}`);
  process.exit(2);
}

const appPlist = path.join(appPath, 'Contents/Info.plist');
const appExecutable = plist(appPlist, 'CFBundleExecutable');
const appExecutablePath = path.join(appPath, 'Contents/MacOS', appExecutable);
const frameworkDir = path.join(appPath, 'Contents/Frameworks');
const helpers = [
  [`${appExecutable} Helper.app`, `${expectedBundleId}.helper`],
  [`${appExecutable} Helper (Renderer).app`, `${expectedBundleId}.helper.Renderer`],
  [`${appExecutable} Helper (GPU).app`, `${expectedBundleId}.helper.GPU`],
  [`${appExecutable} Helper (Plugin).app`, `${expectedBundleId}.helper.Plugin`],
];

const report = {
  appPath,
  installedInApplications: appPath.startsWith('/Applications/'),
  bundleId: plist(appPlist, 'CFBundleIdentifier'),
  expectedBundleId,
  executable: appExecutable,
  verifyDeepStrict: run('codesign', ['--verify', '--deep', '--strict', appPath]),
  spctl: run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]),
  signature: signature(appExecutablePath),
  helpers: helpers.map(([name, expectedId]) => helperReport(frameworkDir, name, expectedId)),
};

console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!report.installedInApplications) failures.push('app is not under /Applications');
if (report.bundleId !== expectedBundleId) failures.push(`bundle id mismatch: ${report.bundleId}`);
if (!report.verifyDeepStrict.ok) failures.push('codesign --verify --deep --strict failed');
if (!report.signature.teamIdentifier || report.signature.teamIdentifier === 'not set') failures.push('missing TeamIdentifier');
for (const helper of report.helpers) {
  if (helper.bundleId !== helper.expectedBundleId) failures.push(`${helper.name} bundle id mismatch: ${helper.bundleId}`);
  if (!helper.verify.ok) failures.push(`${helper.name} codesign verify failed`);
  if (helper.signature.teamIdentifier !== report.signature.teamIdentifier) failures.push(`${helper.name} TeamIdentifier mismatch`);
}

if (failures.length) {
  console.error(`signing check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
