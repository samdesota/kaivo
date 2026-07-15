#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appPath = path.resolve(process.argv[2] || process.env.WEBFRAME_MACOS_APP || '/Applications/Kaivo.app');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function plistValue(plistPath, key) {
  const result = run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath]);
  return result.ok ? result.stdout : undefined;
}

function codesignDetails(target) {
  const result = run('codesign', ['-dv', '--verbose=4', target]);
  const text = `${result.stdout}\n${result.stderr}`;
  const get = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1];
  return {
    ok: result.ok,
    identifier: get('Identifier'),
    signature: get('Signature'),
    teamIdentifier: get('TeamIdentifier'),
    authority: [...text.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1]),
    raw: text.trim(),
  };
}

function codesignVerify(target) {
  return run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', target]);
}

function spctlAssess(target) {
  return run('spctl', ['--assess', '--type', 'execute', '--verbose=4', target]);
}

function helperApps(contentsPath) {
  const frameworks = path.join(contentsPath, 'Frameworks');
  if (!fs.existsSync(frameworks)) return [];
  return fs.readdirSync(frameworks)
    .filter((name) => name.endsWith('.app'))
    .map((name) => path.join(frameworks, name));
}

function expectedHelperSuffix(name) {
  if (name.includes('(Renderer)')) return '.helper.Renderer';
  if (name.includes('(GPU)')) return '.helper.GPU';
  if (name.includes('(Plugin)')) return '.helper.Plugin';
  return '.helper';
}

function main() {
  const contents = path.join(appPath, 'Contents');
  const plist = path.join(contents, 'Info.plist');
  if (!fs.existsSync(plist)) {
    console.error(`App bundle not found or missing Info.plist: ${appPath}`);
    process.exit(1);
  }

  const info = {
    appPath,
    bundleIdentifier: plistValue(plist, 'CFBundleIdentifier'),
    executable: plistValue(plist, 'CFBundleExecutable'),
    name: plistValue(plist, 'CFBundleName'),
    displayName: plistValue(plist, 'CFBundleDisplayName'),
    packageType: plistValue(plist, 'CFBundlePackageType'),
    version: plistValue(plist, 'CFBundleShortVersionString'),
  };
  const appSignature = codesignDetails(appPath);
  const verify = codesignVerify(appPath);
  const assessment = spctlAssess(appPath);
  const helpers = helperApps(contents).map((helperPath) => {
    const helperPlist = path.join(helperPath, 'Contents', 'Info.plist');
    const helperInfo = {
      path: helperPath,
      bundleIdentifier: plistValue(helperPlist, 'CFBundleIdentifier'),
      executable: plistValue(helperPlist, 'CFBundleExecutable'),
    };
    return {
      ...helperInfo,
      signature: codesignDetails(helperPath),
      expectedSuffix: expectedHelperSuffix(path.basename(helperPath)),
    };
  });

  const failures = [];
  const warnings = [];

  if (!appPath.startsWith('/Applications/')) failures.push('app is not directly under /Applications');
  if (info.packageType !== 'APPL') failures.push('CFBundlePackageType is not APPL');
  if (!info.bundleIdentifier) failures.push('CFBundleIdentifier is missing');
  if (info.bundleIdentifier === 'com.electron.kaivo' || info.bundleIdentifier?.startsWith('com.electron.')) {
    warnings.push(`bundle identifier still uses Electron placeholder namespace: ${info.bundleIdentifier}`);
  }
  if (appSignature.signature === 'adhoc') failures.push('app signature is ad-hoc, not Developer ID signed');
  if (!appSignature.teamIdentifier || appSignature.teamIdentifier === 'not set') failures.push('TeamIdentifier is not set');
  if (!verify.ok) failures.push('codesign --verify --deep --strict failed');
  if (!assessment.ok) failures.push('spctl Gatekeeper assessment failed');

  const helperIds = new Map();
  for (const helper of helpers) {
    if (!helper.bundleIdentifier) failures.push(`${path.basename(helper.path)} missing CFBundleIdentifier`);
    helperIds.set(helper.bundleIdentifier, (helperIds.get(helper.bundleIdentifier) || 0) + 1);
    if (helper.signature.signature === 'adhoc') failures.push(`${path.basename(helper.path)} signature is ad-hoc`);
    if (!helper.signature.teamIdentifier || helper.signature.teamIdentifier === 'not set') {
      failures.push(`${path.basename(helper.path)} TeamIdentifier is not set`);
    }
    if (info.bundleIdentifier && helper.bundleIdentifier && !helper.bundleIdentifier.startsWith(`${info.bundleIdentifier}.`)) {
      warnings.push(`${path.basename(helper.path)} identifier does not extend app identifier`);
    }
    if (helper.bundleIdentifier && !helper.bundleIdentifier.endsWith(helper.expectedSuffix)) {
      warnings.push(`${path.basename(helper.path)} identifier does not use expected Electron helper suffix ${helper.expectedSuffix}`);
    }
  }
  for (const [id, count] of helperIds) {
    if (id && count > 1) failures.push(`helper bundle identifier is reused ${count} times: ${id}`);
  }

  const report = {
    ok: failures.length === 0,
    info,
    appSignature: {
      identifier: appSignature.identifier,
      signature: appSignature.signature,
      teamIdentifier: appSignature.teamIdentifier,
      authority: appSignature.authority,
    },
    codesignVerify: { ok: verify.ok, output: verify.stderr || verify.stdout },
    spctl: { ok: assessment.ok, output: assessment.stderr || assessment.stdout },
    helpers: helpers.map((helper) => ({
      path: helper.path,
      bundleIdentifier: helper.bundleIdentifier,
      executable: helper.executable,
      signature: helper.signature.signature,
      teamIdentifier: helper.signature.teamIdentifier,
      expectedSuffix: helper.expectedSuffix,
    })),
    failures,
    warnings,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

main();
