import { app, dialog, ipcMain, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApp, createMemoryHistoryStore, createMemoryTabStore } from '../src/index';
import type { ChromeExtensionRuntimeOptions } from '../src/chrome-extension-runtime';
import type { ExtensionInput } from '../src/extensions';
import type { ExperimentalNativeMessagingOptions } from '../src/native-messaging';
import type { HistoryStore, TabStore } from '../src/stores/types';

// -----------------------------------------------------------------------------
// Error visibility: Electron's default `dialog.showErrorBox` pops a native
// alert that only the user can dismiss. We replace it with a file logger so
// errors are captured for anyone driving the app programmatically.
// -----------------------------------------------------------------------------
const logPath = process.env.WEBFRAME_LOG ?? '/tmp/webframe-test-app.log';
const appName = process.env.WEBFRAME_APP_NAME ?? 'WebFrame Test App';
const userDataPath = process.env.WEBFRAME_USER_DATA_DIR;
app.setName(appName);
if (userDataPath) app.setPath('userData', userDataPath);
try {
  fs.writeFileSync(logPath, `--- launch ${new Date().toISOString()} ---\n`);
} catch {
  // ignore
}
function logLine(level: string, ...parts: unknown[]) {
  const line =
    `[${new Date().toISOString()}] [${level}] ` +
    parts
      .map((p) => {
        if (p instanceof Error) return `${p.message}\n${p.stack ?? ''}`;
        if (typeof p === 'string') return p;
        try {
          return JSON.stringify(p);
        } catch {
          return String(p);
        }
      })
      .join(' ') +
    '\n';
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    // ignore
  }
  // Also mirror to stderr so Playwright-driven runs still see it in stdio.
  process.stderr.write(line);
}

dialog.showErrorBox = (title: string, message: string) => {
  logLine('error', 'dialog.showErrorBox suppressed:', title, '-', message);
};

process.on('uncaughtException', (err) => logLine('uncaught', err));
process.on('unhandledRejection', (reason) => logLine('unhandled', reason));

// -----------------------------------------------------------------------------

function parseExtensionsEnv(): ExtensionInput[] | undefined {
  const raw = process.env.WEBFRAME_EXTENSIONS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ExtensionInput[];
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (e) {
    logLine('warn', 'failed to parse WEBFRAME_EXTENSIONS', e);
    return undefined;
  }
}

function parseNativeMessagingEnv(): ExperimentalNativeMessagingOptions | undefined {
  const raw = process.env.WEBFRAME_NATIVE_MESSAGING;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ExperimentalNativeMessagingOptions;
  } catch (e) {
    logLine('warn', 'failed to parse WEBFRAME_NATIVE_MESSAGING', e);
    return undefined;
  }
}

function parseChromeExtensionsEnv(): ChromeExtensionRuntimeOptions | undefined {
  const raw = process.env.WEBFRAME_CHROME_EXTENSIONS;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ChromeExtensionRuntimeOptions;
  } catch (e) {
    logLine('warn', 'failed to parse WEBFRAME_CHROME_EXTENSIONS', e);
    return undefined;
  }
}

async function main() {
  await app.whenReady();

  const useSqlite = process.env.USE_SQLITE === '1';
  let historyStore: HistoryStore;
  let tabStore: TabStore;
  if (useSqlite) {
    const sqlite = await import('../sqlite/src/index');
    const dbPath = path.join(app.getPath('userData'), 'webframe-test.db');
    historyStore = sqlite.createSqliteHistoryStore({ dbPath });
    tabStore = sqlite.createSqliteTabStore({ dbPath });
  } else {
    historyStore = createMemoryHistoryStore();
    tabStore = createMemoryTabStore();
  }

  const wf = await createApp({
    historyStore,
    tabStore,
    session: process.env.WEBFRAME_SESSION_PARTITION,
    tabUserAgent: process.env.WEBFRAME_TAB_USER_AGENT,
    extensions: parseExtensionsEnv(),
    nativeMessaging: parseNativeMessagingEnv(),
    chromeExtensions: parseChromeExtensionsEnv(),
    logger: {
      warn: (...a) => logLine('warn', ...a),
      error: (...a) => logLine('error', ...a),
    },
  });
  let onePasswordPopupOverlayId: string | undefined;
  ipcMain.handle('webframe/test/1password-trigger-action', async (_event, args: { extensionId: string; tabId?: string }) => {
    await wf.extensions.triggerAction(args.extensionId, { tabId: args.tabId });
  });
  ipcMain.handle('webframe/test/1password-open-popup', async (_event, args: {
    extensionId: string;
    windowId: string;
    placement: { x: number; y: number; w: number; h: number };
  }) => {
    if (!onePasswordPopupOverlayId) {
      const popup = await wf.caller.overlays.createDetached({
        url: `chrome-extension://${args.extensionId}/popup/index.html`,
        transparent: false,
      });
      onePasswordPopupOverlayId = popup.id;
    }
    return await wf.caller.overlays.attach({
      overlayId: onePasswordPopupOverlayId,
      windowId: args.windowId,
      placement: args.placement,
    });
  });
  ipcMain.handle('webframe/test/1password-close-popup', async () => {
    if (!onePasswordPopupOverlayId) return null;
    return await wf.caller.overlays.detach({ overlayId: onePasswordPopupOverlayId });
  });
  ipcMain.handle('webframe/test/open-tab-devtools', async (_event, args: { tabId?: string }) => {
    if (!args.tabId) throw new Error('No active tab selected');
    const wc = wf.tabs.getWebContents(args.tabId);
    if (!wc) throw new Error(`No WebContents for tab ${args.tabId}`);
    wc.openDevTools({ mode: 'detach', activate: true });
  });

  // Right-most display placement for interactive launches. Playwright runs
  // set WEBFRAME_NO_RIGHTMOST=1 so tests stay on the primary display.
  let placement: { x?: number; y?: number; width: number; height: number } = {
    width: 1280,
    height: 800,
  };
  if (!process.env.WEBFRAME_NO_RIGHTMOST) {
    const displays = screen.getAllDisplays();
    const rightmost = displays.reduce((acc, d) =>
      d.bounds.x > acc.bounds.x ? d : acc,
    );
    const w = Math.min(placement.width, rightmost.workArea.width - 40);
    const h = Math.min(placement.height, rightmost.workArea.height - 40);
    placement = {
      width: w,
      height: h,
      x: rightmost.workArea.x + Math.floor((rightmost.workArea.width - w) / 2),
      y: rightmost.workArea.y + Math.floor((rightmost.workArea.height - h) / 2),
    };
  }

  const chromeHtmlPath = path.resolve(__dirname, '..', '..', 'chrome.html');

  const win = await wf.windows.create({
    chromeUrl: `file://${chromeHtmlPath}`,
    chromePreload: path.resolve(__dirname, 'preload-chrome.js'),
    electronWindow: {
      ...placement,
      show: !process.env.WEBFRAME_HIDE,
    },
    initialSlots: [
      { name: 'content', rect: { x: 0, y: 48, w: placement.width, h: placement.height - 48 } },
    ],
  });

  // Mirror renderer console output into the same log so we see errors that
  // originate in the chrome/tab pages.
  win.electronWindow.webContents.on('console-message', (_evt, level, msg, line, sourceId) => {
    const lvlName = ['verbose', 'info', 'warn', 'error'][level] ?? 'log';
    logLine(`chrome:${lvlName}`, `${msg} (${sourceId}:${line})`);
  });
  win.electronWindow.webContents.on('render-process-gone', (_evt, details) => {
    logLine('chrome:crashed', details);
  });

  // Stash for Playwright introspection via electronApp.evaluate.
  const g = globalThis as unknown as Record<string, unknown>;
  g.wf = wf;
  g.stores = { historyStore, tabStore };
  g.mainWindowId = win.id;
  g.mainWindow = win;
  g.logPath = logPath;

  logLine('info', `test-app ready, window ${win.id}, log ${logPath}`);

  if (process.env.WEBFRAME_1PASSWORD_INTERACTIVE === '1') {
    const extensionId = process.env.WEBFRAME_1PASSWORD_EXTENSION_ID ?? 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';
    const startUrl = process.env.WEBFRAME_INTERACTIVE_START_URL ?? 'https://example.com';
    try {
      const targetTab = await wf.caller.tabs.create({
        url: startUrl,
        windowId: win.id,
        placement: { slot: 'content' },
        active: true,
      });
      logLine('info', 'interactive target tab opened', targetTab.id, startUrl);

      if (process.env.WEBFRAME_TRIGGER_1PASSWORD_ACTION !== '0') {
        await wf.extensions.triggerAction(extensionId, { tabId: targetTab.id });
        logLine('info', 'interactive 1Password action triggered', extensionId, targetTab.id);
      }

      logLine('info', 'interactive 1Password popup available from toolbar', extensionId);
    } catch (e) {
      logLine('error', 'interactive 1Password setup failed', e);
    }
  }
}

void main().catch((err) => {
  logLine('fatal', err);
  // Exit non-zero so parent processes know the launch failed.
  process.exit(1);
});
