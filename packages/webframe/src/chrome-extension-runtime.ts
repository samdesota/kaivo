import type { BaseWindow, Session, WebContents } from 'electron';
import type { ElectronChromeExtensions as ElectronChromeExtensionsType } from 'electron-chrome-extensions';

export type ChromeExtensionRuntimeOptions = {
  enabled?: boolean;
  /** License accepted for electron-chrome-extensions. Defaults to GPL-3.0. */
  license?: 'GPL-3.0' | 'Patron-License-2020-11-19';
};

export type ChromeExtensionRuntimeDeps = {
  session: Session;
  options?: ChromeExtensionRuntimeOptions;
  createTab(details: chrome.tabs.CreateProperties): Promise<[WebContents, BaseWindow]>;
  selectTab(tab: WebContents, window: BaseWindow): void;
  removeTab(tab: WebContents, window: BaseWindow): void;
  assignTabDetails(details: chrome.tabs.Tab, tab: WebContents): void;
  createWindow(details: chrome.windows.CreateData): Promise<BaseWindow>;
  removeWindow(window: BaseWindow): void;
};

export type ChromeExtensionRuntime = {
  addTab(tab: WebContents, window: BaseWindow): void;
  removeTab(tab: WebContents): void;
  selectTab(tab: WebContents): void;
  triggerAction(extensionId: string, tab: WebContents, window: BaseWindow): Promise<void>;
};

export function createChromeExtensionRuntime(
  deps: ChromeExtensionRuntimeDeps,
): ChromeExtensionRuntime | undefined {
  if (deps.options?.enabled !== true) return undefined;

  // electron-chrome-extensions touches Electron app state at module load time,
  // so defer loading until runtime instead of during package import smoke tests.
  const { ElectronChromeExtensions } = require('electron-chrome-extensions') as {
    ElectronChromeExtensions: typeof ElectronChromeExtensionsType;
  };

  const runtime = new ElectronChromeExtensions({
    license: deps.options?.license ?? 'GPL-3.0',
    session: deps.session,
    createTab: deps.createTab,
    selectTab: deps.selectTab,
    removeTab: deps.removeTab,
    assignTabDetails: deps.assignTabDetails,
    createWindow: deps.createWindow,
    removeWindow: deps.removeWindow,
  });
  try {
    // WebFrame relies on Electron's built-in content-script/runtime messaging in
    // normal pages. The package's frame preload is mainly for extension hosts and
    // can intercept that path; keep its MV3 service-worker preload for the API
    // surface we need in extension background workers.
    deps.session.unregisterPreloadScript('crx-mv2-preload');
  } catch {
    // Older Electron versions or package changes may not register this id.
  }

  return {
    addTab(tab, window) {
      runtime.addTab(tab, window);
    },
    removeTab(tab) {
      runtime.removeTab(tab);
    },
    selectTab(tab) {
      runtime.selectTab(tab);
    },
    async triggerAction(extensionId, tab, window) {
      const internals = runtime as unknown as {
        api?: {
          browserAction?: {
            activateClick(details: {
              extensionId: string;
              tabId: number;
              anchorRect: { x: number; y: number; width: number; height: number };
            }): void;
          };
        };
      };
      const [width] = 'getSize' in window ? window.getSize() : [64];
      internals.api?.browserAction?.activateClick({
        extensionId,
        tabId: tab.id,
        anchorRect: { x: Math.max(0, width - 64), y: 0, width: 64, height: 64 },
      });
    },
  };
}
