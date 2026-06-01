#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sign } = require('@electron/osx-sign');

const appPath = process.argv[2] || path.resolve(__dirname, '../release/Kaivo-darwin-arm64/Kaivo.app');
const bundleId = process.env.KAIVO_BUNDLE_ID || 'com.samdesota.kaivo';
const identity = process.env.KAIVO_SIGN_IDENTITY || 'Developer ID Application: Samuel DeSota';
const appName = process.env.KAIVO_APP_NAME || 'Kaivo';

function plistBuddy(plist, ...args) {
  return execFileSync('/usr/libexec/PlistBuddy', [plist, ...args], { encoding: 'utf8' }).trim();
}

function setPlist(plist, key, value) {
  try {
    plistBuddy(plist, '-c', `Set :${key} ${value}`);
  } catch {
    plistBuddy(plist, '-c', `Add :${key} string ${value}`);
  }
}

function requireAppBundle(app) {
  const plist = path.join(app, 'Contents/Info.plist');
  if (!fs.existsSync(plist)) throw new Error(`missing app Info.plist: ${plist}`);
  return plist;
}

async function main() {
  const appPlist = requireAppBundle(appPath);
  setPlist(appPlist, 'CFBundleIdentifier', bundleId);
  setPlist(appPlist, 'CFBundleName', appName);
  setPlist(appPlist, 'CFBundleDisplayName', appName);
  setPlist(appPlist, 'CFBundleExecutable', appName);

  const frameworkDir = path.join(appPath, 'Contents/Frameworks');
  const helpers = [
    [`${appName} Helper.app`, `${bundleId}.helper`],
    [`${appName} Helper (Renderer).app`, `${bundleId}.helper.Renderer`],
    [`${appName} Helper (GPU).app`, `${bundleId}.helper.GPU`],
    [`${appName} Helper (Plugin).app`, `${bundleId}.helper.Plugin`],
  ];
  for (const [helperName, helperBundleId] of helpers) {
    const helperPlist = path.join(frameworkDir, helperName, 'Contents/Info.plist');
    if (!fs.existsSync(helperPlist)) throw new Error(`missing helper Info.plist: ${helperPlist}`);
    setPlist(helperPlist, 'CFBundleIdentifier', helperBundleId);
  }

  await sign({
    app: appPath,
    identity,
    platform: 'darwin',
    type: 'distribution',
  });

  console.log(JSON.stringify({ appPath, bundleId, identity }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
