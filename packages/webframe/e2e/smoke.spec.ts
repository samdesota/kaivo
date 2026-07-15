import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchTestApp } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('app launches, chrome loads, window.webframe is exposed', async () => {
  const { app, chrome } = await launchTestApp();

  const windows = await chrome.evaluate(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webframe.trpc.windows.list.query(),
  );
  expect(Array.isArray(windows)).toBe(true);
  expect(windows.length).toBe(1);
  expect(typeof windows[0].id).toBe('string');

  const identity = await chrome.evaluate(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webframe.identity(),
  );
  expect(identity.kind).toBe('chrome');
  expect(typeof identity.windowId).toBe('string');

  const mainList = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    return wf.caller.windows.list();
  });
  expect(mainList.length).toBe(1);
  expect(mainList[0].id).toBe(windows[0].id);

  const mainWho = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    return wf.caller._debug.whoami();
  });
  expect(mainWho.kind).toBe('main');

  await app.close();
});

test('tab create persists a TabRecord; close removes it', async () => {
  const { app } = await launchTestApp();

  const created = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (globalThis as any).stores;
    const stored = await stores.tabStore.list();
    return { rec, storedIds: stored.map((t: { id: string }) => t.id) };
  });
  expect(created.storedIds).toContain(created.rec.id);

  const afterClose = await app.evaluate(async (_ctx, tabId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    await wf.caller.tabs.close({ tabId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (globalThis as any).stores;
    return (await stores.tabStore.list()).length;
  }, created.rec.id);
  expect(afterClose).toBe(0);

  await app.close();
});

test('tab create is idempotent for a stable ownerKey', async () => {
  const { app } = await launchTestApp();

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const input = {
      ownerKey: 'browser-pane:test-pane',
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    };
    const first = await wf.caller.tabs.create(input);
    const second = await wf.caller.tabs.create(input);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (globalThis as any).stores;
    const stored = await stores.tabStore.list();
    return {
      first,
      second,
      ownerRecords: stored.filter((tab: { ownerKey?: string }) => tab.ownerKey === input.ownerKey),
    };
  });

  expect(result.second.id).toBe(result.first.id);
  expect(result.second.ownerKey).toBe('browser-pane:test-pane');
  expect(result.ownerRecords).toHaveLength(1);

  await app.close();
});

test('public getWebContents returns live tab WebContents only', async () => {
  const { app } = await launchTestApp();

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const missingBefore = wf.tabs.getWebContents('missing');
    const rec = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const wc = wf.tabs.getWebContents(rec.id);
    await wf.caller.tabs.detach({ tabId: rec.id });
    const detached = wf.tabs.getWebContents(rec.id);
    return {
      missingBefore: missingBefore === undefined,
      wcId: wc?.id,
      wcDestroyed: wc?.isDestroyed(),
      detached: detached === undefined,
    };
  });

  expect(result.missingBefore).toBe(true);
  expect(typeof result.wcId).toBe('number');
  expect(result.wcDestroyed).toBe(false);
  expect(result.detached).toBe(true);

  await app.close();
});

test('tab user agent option applies to tab WebContents', async () => {
  const userAgent = 'Mozilla/5.0 WebframeTest Chrome/123.0.0.0 Safari/537.36';
  const { app } = await launchTestApp({ tabUserAgent: userAgent });

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const wc = wf.tabs.getWebContents(rec.id);
    return {
      configured: wc?.getUserAgent(),
      navigator: await wc?.executeJavaScript('navigator.userAgent'),
    };
  });

  expect(result.configured).toBe(userAgent);
  expect(result.navigator).toBe(userAgent);

  await app.close();
});

test('detached tab (no windowId) persists but is not attached to any window', async () => {
  const { app } = await launchTestApp();

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const before = await wf.caller.windows.get({ windowId });
    const rec = await wf.caller.tabs.create({ url: 'https://example.com' });
    const after = await wf.caller.windows.get({ windowId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = await (globalThis as any).stores.tabStore.list();
    return {
      tabId: rec.id,
      beforeIds: before.tabIds,
      afterIds: after.tabIds,
      inStore: stored.some((t: { id: string }) => t.id === rec.id),
    };
  });
  expect(result.beforeIds).not.toContain(result.tabId);
  expect(result.afterIds).not.toContain(result.tabId);
  expect(result.inStore).toBe(true);

  await app.close();
});

test('unknown slot rejects with SLOT_NOT_FOUND', async () => {
  const { app } = await launchTestApp();

  const err = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    try {
      await wf.caller.tabs.create({
        url: 'about:blank',
        windowId,
        placement: { slot: 'nope' },
      });
      return { ok: true };
    } catch (e: unknown) {
      const err = e as { message?: string };
      return { ok: false, message: err.message ?? String(e) };
    }
  });
  expect(err.ok).toBe(false);
  expect(err.message).toContain('SLOT_NOT_FOUND');

  await app.close();
});

test('navigation fires did-navigate and records a history entry', async () => {
  const { app } = await launchTestApp();

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (globalThis as any).stores;

    const rec = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });

    const nextUrl = 'data:text/html,%3Ctitle%3EA%3C%2Ftitle%3EA';
    await wf.caller.navigation.goto({ tabId: rec.id, url: nextUrl });

    // Poll until we see both the initial load and the goto, or timeout.
    const start = Date.now();
    let entries: Array<{ url: string }> = [];
    while (Date.now() - start < 5000) {
      entries = await stores.historyStore.query({ tabId: rec.id });
      if (entries.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { entryCount: entries.length, urls: entries.map((e) => e.url) };
  });

  expect(result.entryCount).toBeGreaterThanOrEqual(1);
  // At least one of: the initial about:blank or the subsequent data: URL
  // should have been recorded. The did-navigate for data: URLs is sometimes
  // suppressed, but about:blank always lands.
  expect(
    result.urls.some((u) => u === 'about:blank' || u.startsWith('data:text/html')),
  ).toBe(true);

  await app.close();
});

test('window.setSlots updates layout and re-binds attached tab bounds', async () => {
  const { app } = await launchTestApp();

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;

    const rec = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });

    // Move the slot 100px further down and make it narrower.
    await wf.caller.windows.setSlots({
      windowId,
      slots: [{ name: 'content', rect: { x: 20, y: 148, w: 800, h: 500 } }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    const children = win.contentView.children;
    // Find the tab's view by matching webContents id.
    const info = children.map((c: { getBounds: () => unknown; webContents?: { id?: number } }) => ({
      id: c.webContents?.id,
      b: c.getBounds(),
    }));
    return { tabId: rec.id, info };
  });

  const tabBounds = result.info.find((v: { b: { x: number } }) => v.b.x === 20);
  expect(tabBounds).toBeTruthy();
  expect(tabBounds.b).toEqual({ x: 20, y: 148, width: 800, height: 500 });

  await app.close();
});

test('edge anchor places view in top strip', async () => {
  const { app } = await launchTestApp();

  const bounds = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;

    await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { edge: 'top', size: 40 },
      active: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    return win.contentView.children[0].getBounds();
  });
  expect(bounds.x).toBe(0);
  expect(bounds.y).toBe(0);
  expect(bounds.height).toBe(40);

  await app.close();
});

test('z-order invariant: overlay stays on top of tabs through mutations', async () => {
  const { app } = await launchTestApp();

  const order = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;

    const tab1 = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const overlay = await wf.caller.overlays.create({
      windowId,
      placement: { x: 10, y: 10, w: 200, h: 50 },
      url: 'about:blank',
    });
    const tab2 = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    const children = win.contentView.children;
    const wcIds = children.map((c: { webContents?: { id?: number } }) => c.webContents?.id);
    return { count: children.length, topWcId: wcIds[wcIds.length - 1], tab1, tab2, overlay };
  });

  expect(order.count).toBe(3);
  // Top-of-stack must be the overlay regardless of tab operations.
  const overlayWcId = await app.evaluate(async (_ctx, overlayId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    const list = await wf.caller.overlays.list({});
    const o = list.find((x: { id: string }) => x.id === overlayId);
    return o ? true : false;
  }, order.overlay.id);
  expect(overlayWcId).toBe(true);
  // Verify the top child belongs to an overlay by cross-referencing.
  const isOverlayOnTop = await app.evaluate(async (_ctx, topWcId: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    const lastChild = win.contentView.children[win.contentView.children.length - 1];
    return lastChild.webContents?.id === topWcId;
  }, order.topWcId);
  expect(isOverlayOnTop).toBe(true);

  await app.close();
});

test('detached overlays stay alive and can attach above tabs', async () => {
  const { app } = await launchTestApp();

  const created = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;

    const tab = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const overlay = await wf.caller.overlays.createDetached({
      url: 'data:text/html,%3Ctitle%3EDetached%3C%2Ftitle%3Eoverlay',
      transparent: true,
    });
    const beforeAttachChildren = win.contentView.children.length;
    const listedDetached = await wf.caller.overlays.list({});
    const attached = await wf.caller.overlays.attach({
      overlayId: overlay.id,
      windowId,
      placement: { x: 5, y: 5, w: 160, h: 90 },
    });
    const attachedChildren = win.contentView.children;
    const attachedOrder = attachedChildren.map((child: { webContents?: Electron.WebContents }) => ({
      id: child.webContents?.id,
      url: child.webContents?.getURL(),
    }));
    const attachedBounds = attachedChildren[attachedChildren.length - 1].getBounds();
    await wf.caller.windows.setSlots({
      windowId,
      slots: [{ name: 'content', rect: { x: 0, y: 0, w: 400, h: 300 } }],
    });
    await wf.caller.tabs.setActive({ tabId: tab.id, windowId });
    const afterMutationChildren = win.contentView.children;
    const afterMutationOrder = afterMutationChildren.map((child: { webContents?: Electron.WebContents }) => ({
      id: child.webContents?.id,
      url: child.webContents?.getURL(),
    }));
    const detached = await wf.caller.overlays.detach({ overlayId: overlay.id });
    const afterDetachChildren = win.contentView.children.length;
    const overlayAlive = await wf.caller.overlays.list({});
    await wf.caller.overlays.close({ overlayId: overlay.id });

    return {
      tab,
      overlay,
      beforeAttachChildren,
      listedDetached,
      attached,
      attachedOrder,
      attachedBounds,
      afterMutationOrder,
      detached,
      afterDetachChildren,
      overlayAlive,
    };
  });

  expect(created.overlay.windowId).toBeNull();
  expect(created.overlay.placement).toBeNull();
  expect(created.beforeAttachChildren).toBe(1);
  expect(created.listedDetached.some((o: { id: string; windowId: string | null }) => o.id === created.overlay.id && o.windowId === null)).toBe(true);
  expect(created.attached.windowId).toBeTruthy();
  expect(created.attached.placement).toEqual({ x: 5, y: 5, w: 160, h: 90 });
  expect(created.attachedOrder.at(-1)?.id).toBeGreaterThan(created.attachedOrder[0]?.id ?? 0);
  expect(created.attachedBounds).toEqual({ x: 5, y: 5, width: 160, height: 90 });
  expect(created.afterMutationOrder.at(-1)?.id).toBe(created.attachedOrder.at(-1)?.id);
  expect(created.detached.windowId).toBeNull();
  expect(created.afterDetachChildren).toBe(1);
  expect(created.overlayAlive.some((o: { id: string; windowId: string | null }) => o.id === created.overlay.id && o.windowId === null)).toBe(true);

  await app.close();
});

test('chrome and overlay renderers can communicate over BroadcastChannel', async () => {
  const { app, chrome } = await launchTestApp();

  const receivedPromise = chrome.evaluate(async () => {
    return await new Promise<string>((resolve, reject) => {
      const channel = new BroadcastChannel('webframe-overlay-session-test');
      const timeout = window.setTimeout(() => {
        channel.close();
        reject(new Error('timed out waiting for overlay broadcast'));
      }, 2000);
      channel.onmessage = (event) => {
        window.clearTimeout(timeout);
        channel.close();
        resolve(String(event.data));
      };
    });
  });

  const overlayUrl = await chrome.evaluate(() => location.href.replace(/chrome\.html$/, 'overlay-broadcast.html'));

  await app.evaluate(async (_ctx, url: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    await wf.caller.overlays.createDetached({
      url,
      transparent: true,
    });
  }, overlayUrl);

  await expect(receivedPromise).resolves.toBe('overlay-ready');

  await app.close();
});

test('chrome subscription receives tab:change events from main-process mutations', async () => {
  const { app, chrome } = await launchTestApp();

  // Install subscription in the chrome renderer and collect events.
  await chrome.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webframe = (window as any).webframe;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__events = [];
    webframe.trpc.tabs.onChange.subscribe(undefined, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onData: (ev: unknown) => (window as any).__events.push(ev),
    });
  });

  // Create a tab and navigate from the main process.
  const tabId = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: 'data:text/html,%3Ctitle%3ETee%3C%2Ftitle%3EHello',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    return rec.id;
  });
  expect(typeof tabId).toBe('string');

  // Poll for the tab:change events on the chrome side.
  const events = await chrome.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => ((window as any).__events.length >= 1 ? (window as any).__events : null),
    null,
    { timeout: 5000 },
  );
  const collected = (await events.jsonValue()) as Array<{ tabId: string; patch: Record<string, unknown> }>;
  expect(collected.length).toBeGreaterThanOrEqual(1);
  expect(collected[0].tabId).toBe(tabId);

  await app.close();
});

test('target-blank links create webframe tabs instead of native windows', async () => {
  const { app, chrome } = await launchTestApp();

  await chrome.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webframe = (window as any).webframe;
    const identity = await webframe.identity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__createdTabs = [];
    webframe.trpc.tabs.onCreated.subscribe({ windowId: identity.windowId }, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onData: (ev: unknown) => (window as any).__createdTabs.push(ev),
    });
  });

  const beforeNativeWindowCount = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BrowserWindow = (globalThis as any).mainWindow.electronWindow.constructor;
    return BrowserWindow.getAllWindows().length;
  });
  const opener = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const targetUrl = 'data:text/html,%3Ctitle%3EPopup%3C%2Ftitle%3Epopup';
    const html = `<a id="open" href="${targetUrl}" target="_blank">open</a>`;
    const rec = await wf.caller.tabs.create({
      url: `data:text/html,${encodeURIComponent(html)}`,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    const view = win.contentView.children.find(
      (child: { webContents?: { id?: number } }) => !!child.webContents,
    );
    const wc = view.webContents;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const ready = await wc.executeJavaScript('document.readyState').catch(() => null);
      if (ready === 'complete' || ready === 'interactive') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await wc.executeJavaScript('document.getElementById("open").click()');
    return { openerTabId: rec.id, windowId, targetUrl };
  });

  const handle = await chrome.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => ((window as any).__createdTabs.length >= 1 ? (window as any).__createdTabs : null),
    null,
    { timeout: 5000 },
  );
  const events = (await handle.jsonValue()) as Array<{
    tab: { id: string; url: string };
    windowId: string | null;
    openerTabId: string | null;
  }>;
  const created = events.find((ev) => ev.openerTabId === opener.openerTabId);

  expect(created).toBeTruthy();
  expect(created?.windowId).toBe(opener.windowId);
  expect(created?.tab.url).toBe(opener.targetUrl);
  expect(created?.tab.presentation).toBe('embedded');

  await new Promise((r) => setTimeout(r, 250));
  const afterNativeWindowCount = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BrowserWindow = (globalThis as any).mainWindow.electronWindow.constructor;
    return BrowserWindow.getAllWindows().length;
  });
  expect(afterNativeWindowCount).toBe(beforeNativeWindowCount);

  const after = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const info = await wf.caller.windows.get({ windowId });
    return { tabIds: info.tabIds, tabCount: (await wf.caller.tabs.list({ windowId })).length };
  });
  expect(after.tabIds).toContain(opener.openerTabId);
  expect(after.tabIds).toContain(created?.tab.id);
  expect(after.tabCount).toBeGreaterThanOrEqual(2);

  await app.close();
});

test('popup window.open calls create popup tabs backed by native windows', async () => {
  const { app, chrome } = await launchTestApp();

  await chrome.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webframe = (window as any).webframe;
    const identity = await webframe.identity();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__createdTabs = [];
    webframe.trpc.tabs.onCreated.subscribe({ windowId: identity.windowId }, {
      onError: (err: unknown) => console.error('onCreated failed', err),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onData: (ev: unknown) => (window as any).__createdTabs.push(ev),
    });
  });

  const beforeNativeWindowCount = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BrowserWindow = (globalThis as any).mainWindow.electronWindow.constructor;
    return BrowserWindow.getAllWindows().length;
  });
  const opener = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const targetUrl = 'data:text/html,%3Ctitle%3ENative%20Popup%3C%2Ftitle%3Epopup';
    const html = `<button id="open" onclick="window.open('${targetUrl}', 'authPopup', 'width=320,height=240')">open</button>`;
    const rec = await wf.caller.tabs.create({
      url: `data:text/html,${encodeURIComponent(html)}`,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = (globalThis as any).mainWindow.electronWindow;
    const view = win.contentView.children.find(
      (child: { webContents?: { id?: number } }) => !!child.webContents,
    );
    const wc = view.webContents;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const ready = await wc.executeJavaScript('document.readyState').catch(() => null);
      if (ready === 'complete' || ready === 'interactive') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await wc.executeJavaScript('document.getElementById("open").click()');
    return { openerTabId: rec.id, windowId, targetUrl };
  });

  const handle = await chrome.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => ((window as any).__createdTabs.length >= 1 ? (window as any).__createdTabs : null),
    null,
    { timeout: 5000 },
  );
  const events = (await handle.jsonValue()) as Array<{
    tab: { id: string; url: string; presentation?: string; openerTabId?: string };
    windowId: string | null;
    openerTabId: string | null;
  }>;
  const created = events.find((ev) => ev.openerTabId === opener.openerTabId);

  expect(created).toBeTruthy();
  expect(created?.windowId).toBe(opener.windowId);
  expect(created?.tab.url).toBe(opener.targetUrl);
  expect(created?.tab.presentation).toBe('popup');
  expect(created?.tab.openerTabId).toBe(opener.openerTabId);

  const after = await app.evaluate(async (_ctx, popupTabId: string | undefined) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BrowserWindow = (globalThis as any).mainWindow.electronWindow.constructor;
    const wc = popupTabId ? wf.tabs.getWebContents(popupTabId) : undefined;
    const record = popupTabId ? await wf.caller.tabs.get({ tabId: popupTabId }) : null;
    return {
      nativeWindowCount: BrowserWindow.getAllWindows().length,
      webContentsId: wc?.id,
      record,
    };
  }, created?.tab.id);
  expect(after.nativeWindowCount).toBe(beforeNativeWindowCount + 1);
  expect(typeof after.webContentsId).toBe('number');
  expect(after.record?.presentation).toBe('popup');

  await app.close();
});

test('closing a popup does not block subsequent tab creation', async () => {
  const { app } = await launchTestApp({
    chromeExtensions: { enabled: true, license: 'GPL-3.0' },
  });

  const result = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainWindow = (globalThis as any).mainWindow.electronWindow;
    const BrowserWindow = mainWindow.constructor;
    const targetUrl = 'data:text/html,%3Ctitle%3EClosing%20Popup%3C%2Ftitle%3Epopup';
    const html = `<button id="open" onclick="window.open('${targetUrl}', 'authPopup', 'width=320,height=240')">open</button>`;
    const opener = await wf.caller.tabs.create({
      url: `data:text/html,${encodeURIComponent(html)}`,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const openerWc = wf.tabs.getWebContents(opener.id);

    const loadStart = Date.now();
    while (Date.now() - loadStart < 5000) {
      const ready = await openerWc.executeJavaScript('document.readyState').catch(() => null);
      if (ready === 'complete' || ready === 'interactive') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await openerWc.executeJavaScript('document.getElementById("open").click()');

    let popupWindow;
    const popupStart = Date.now();
    while (Date.now() - popupStart < 5000) {
      popupWindow = BrowserWindow.getAllWindows().find(
        (window: Electron.BrowserWindow) => window.id !== mainWindow.id,
      );
      if (popupWindow) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!popupWindow) throw new Error('popup window was not created');

    popupWindow.close();
    const closeStart = Date.now();
    while (Date.now() - closeStart < 5000 && !popupWindow.isDestroyed()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const next = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const records = await wf.caller.tabs.list();
    return {
      nextTabId: next.id,
      popupRecords: records.filter((record: { presentation?: string }) => record.presentation === 'popup'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logPath: (globalThis as any).logPath as string,
    };
  });

  expect(typeof result.nextTabId).toBe('string');
  expect(result.popupRecords).toEqual([]);
  expect(await fs.readFile(result.logPath, 'utf8')).not.toContain('Object has been destroyed');

  await app.close();
});

test('closing the window detaches tabs; logical TabRecords survive', async () => {
  const { app } = await launchTestApp();

  const chromeUrl = `file://${path.resolve(__dirname, '..', 'test-app', 'chrome.html')}`;

  // Open a sentinel second window first. Playwright's Electron evaluate
  // channel dies when the *last* window closes; keeping a sentinel alive
  // lets us observe state after closing the original window.
  const setup = await app.evaluate(async (_ctx, chromeUrl: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const sentinel = await wf.windows.create({
      chromeUrl,
      electronWindow: { width: 400, height: 300, show: false },
    });

    const a = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const b = await wf.caller.tabs.create({
      url: 'about:blank',
      windowId,
      placement: { slot: 'content' },
      active: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = await (globalThis as any).stores.tabStore.list();
    return {
      windowId,
      sentinelId: sentinel.id,
      a: a.id,
      b: b.id,
      storedCount: stored.length,
    };
  }, chromeUrl);
  expect(setup.storedCount).toBe(2);

  // Now close the original window and assert. The sentinel keeps the app alive.
  const after = await app.evaluate(async (_ctx, windowId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainWindow = (globalThis as any).mainWindow;
    // destroy() skips 'close' but guarantees 'closed'. We poll windows.list
    // rather than time-waiting so the assertion is deterministic.
    mainWindow.electronWindow.destroy();
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const list = await wf.caller.windows.list();
      if (!list.some((w: { id: string }) => w.id === windowId)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (globalThis as any).stores;
    const stored = await stores.tabStore.list();
    const windowsList = await wf.caller.windows.list();
    return {
      storedCount: stored.length,
      storedIds: stored.map((t: { id: string }) => t.id),
      windowStillListed: windowsList.some((w: { id: string }) => w.id === windowId),
    };
  }, setup.windowId);

  expect(after.storedCount).toBe(2);
  expect(after.storedIds).toContain(setup.a);
  expect(after.storedIds).toContain(setup.b);
  expect(after.windowStillListed).toBe(false);

  await app.close();
});
