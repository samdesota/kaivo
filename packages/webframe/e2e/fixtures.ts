import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function launchTestApp(opts: {
  useSqlite?: boolean;
  tabUserAgent?: string;
  extensions?: Array<string | { path: string; allowFileAccess?: boolean }>;
  nativeMessaging?: { hosts?: Array<{ manifestPath: string; hostName?: string; allowedExtensionIds: string[] }> };
  chromeExtensions?: { enabled?: boolean; license?: 'GPL-3.0' | 'Patron-License-2020-11-19' };
} = {}): Promise<{
  app: ElectronApplication;
  chrome: Page;
}> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.useSqlite) env.USE_SQLITE = '1';
  if (opts.tabUserAgent) env.WEBFRAME_TAB_USER_AGENT = opts.tabUserAgent;
  if (opts.extensions) {
    env.WEBFRAME_EXTENSIONS = JSON.stringify(opts.extensions);
    env.WEBFRAME_SESSION_PARTITION = `persist:webframe-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
  if (opts.nativeMessaging) env.WEBFRAME_NATIVE_MESSAGING = JSON.stringify(opts.nativeMessaging);
  if (opts.chromeExtensions) env.WEBFRAME_CHROME_EXTENSIONS = JSON.stringify(opts.chromeExtensions);
  // Run Playwright-spawned test-apps hidden so they don't flash over the
  // user's interactive demo. WEBFRAME_NO_RIGHTMOST skips the multi-display
  // positioning path too (irrelevant when hidden).
  env.WEBFRAME_NO_RIGHTMOST = '1';
  env.WEBFRAME_HIDE = '1';
  // Each test writes to its own log so parallel/sequential runs don't clobber.
  env.WEBFRAME_LOG = `/tmp/webframe-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`;
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..', 'test-app', 'dist', 'test-app', 'main.js')],
    env,
    executablePath: process.env.WEBFRAME_ELECTRON_APP
      ? executableForAppBundle(process.env.WEBFRAME_ELECTRON_APP)
      : undefined,
  });
  const chrome = await app.firstWindow();
  // Wait for window.webframe to become available (preload + init runs async).
  await chrome.waitForFunction(() => !!(globalThis as any).webframe);
  return { app, chrome };
}

function executableForAppBundle(appPath: string): string {
  const resolved = path.resolve(appPath);
  const plist = path.join(resolved, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) throw new Error(`app bundle missing Info.plist: ${resolved}`);
  const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], {
    encoding: 'utf8',
  }).trim();
  return path.join(resolved, 'Contents', 'MacOS', executable);
}

export async function mainEval<T, A = undefined>(
  app: ElectronApplication,
  fn: (args: A) => Promise<T> | T,
  arg?: A,
): Promise<T> {
  // Playwright's evaluate passes a default `{app}` arg; wrap to pass user args.
  return app.evaluate(async (_electronCtx, userArg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (fn as any)(userArg);
  }, arg as A);
}
