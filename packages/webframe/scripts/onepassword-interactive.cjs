#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const extensionId = process.env.WEBFRAME_1PASSWORD_EXTENSION_ID || 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
const extensionPath = process.env.WEBFRAME_1PASSWORD_EXTENSION_PATH ||
  `/Users/sam/Library/Application Support/Vivaldi/Default/Extensions/${extensionId}/8.12.21.1_0`;
const nativeHostManifest = process.env.WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST ||
  '/Users/sam/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.1password.1password.json';
const logPath = process.env.WEBFRAME_LOG || '/tmp/webframe-1password-interactive.log';
const electronApp = process.env.WEBFRAME_ELECTRON_APP;
const appName = process.env.WEBFRAME_APP_NAME || 'WebFrame 1Password Test';
const userDataDir = process.env.WEBFRAME_USER_DATA_DIR || path.join(process.env.HOME || '/tmp', 'Library', 'Application Support', appName);
const sessionPartition = process.env.WEBFRAME_SESSION_PARTITION || 'persist:webframe-1password-interactive';

function requirePath(label, filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} not found: ${filePath}`);
    process.exit(1);
  }
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      stdio: 'inherit',
      ...opts,
    });
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}`));
    });
  });
}

function executableForAppBundle(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error(`app bundle missing Info.plist: ${appPath}`);
  const result = spawn('sh', ['-c', `/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1"`, 'sh', plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  let stderr = '';
  result.stdout.on('data', (chunk) => chunks.push(chunk));
  result.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    result.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`failed to read CFBundleExecutable from ${appPath}: ${stderr.trim()}`));
        return;
      }
      const executable = Buffer.concat(chunks).toString('utf8').trim();
      resolve(path.join(appPath, 'Contents', 'MacOS', executable));
    });
  });
}

function launchAppBundle(appPath, appArgs, env) {
  const args = ['-n', '-W', appPath];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('WEBFRAME_') && key !== 'USE_SQLITE') continue;
    args.push('--env', `${key}=${value}`);
  }
  args.push('--args', ...appArgs);
  return spawn('open', args, {
    cwd: repo,
    stdio: 'inherit',
  });
}

async function main() {
  requirePath('1Password extension', extensionPath);
  requirePath('1Password native host manifest', nativeHostManifest);

  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'build:test-app']);

  const env = {
    ...process.env,
    WEBFRAME_1PASSWORD_INTERACTIVE: '1',
    WEBFRAME_1PASSWORD_EXTENSION_ID: extensionId,
    WEBFRAME_EXTENSIONS: JSON.stringify([{ path: extensionPath, allowFileAccess: true }]),
    WEBFRAME_NATIVE_MESSAGING: JSON.stringify({
      hosts: [
        { manifestPath: nativeHostManifest, allowedExtensionIds: [extensionId] },
        { manifestPath: nativeHostManifest, hostName: 'com.1password.1password7', allowedExtensionIds: [extensionId] },
      ],
    }),
    WEBFRAME_CHROME_EXTENSIONS: JSON.stringify({ enabled: true, license: 'GPL-3.0' }),
    WEBFRAME_SESSION_PARTITION: sessionPartition,
    WEBFRAME_APP_NAME: appName,
    WEBFRAME_USER_DATA_DIR: userDataDir,
    WEBFRAME_LOG: logPath,
  };

  console.error(`Launching WebFrame 1Password harness`);
  console.error(`Extension: ${extensionPath}`);
  console.error(`Native host: ${nativeHostManifest}`);
  console.error(`Log: ${logPath}`);
  console.error(`App name: ${appName}`);
  console.error(`User data: ${userDataDir}`);
  console.error(`Session partition: ${sessionPartition}`);
  if (electronApp) console.error(`Electron app bundle: ${electronApp}`);
  console.error(`Set WEBFRAME_OPEN_1PASSWORD_POPUP=0 or WEBFRAME_TRIGGER_1PASSWORD_ACTION=0 to disable those startup actions.`);

  const appArgs = [path.join(repo, 'test-app', 'dist', 'test-app', 'main.js')];
  const child = electronApp
    ? launchAppBundle(path.resolve(electronApp), appArgs, env)
    : spawn(path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'), appArgs, {
        cwd: repo,
        env,
        stdio: 'inherit',
      });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
