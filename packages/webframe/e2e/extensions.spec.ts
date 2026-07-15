import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchTestApp } from './fixtures';

test.describe.configure({ mode: 'serial' });

const markerExtensionPath = path.resolve(__dirname, 'fixtures', 'extensions', 'marker');
const markerExtensionId = 'cgkdknidejokoidkpfinhgokdpehhiin';
const fakeNativeHostPath = path.resolve(__dirname, 'fixtures', 'native-hosts', 'fake-native-host.cjs');
const targetPageUrl = pathToFileURL(
  path.resolve(__dirname, 'fixtures', 'pages', 'extension-target.html'),
).toString();

async function createFakeNativeHostManifest(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webframe-native-host-'));
  const manifestPath = path.join(dir, 'com.webframe.fixture_native_host.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      name: 'com.webframe.fixture_native_host',
      path: fakeNativeHostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${markerExtensionId}/`],
    }),
  );
  return manifestPath;
}

async function copyMarkerExtensionFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webframe-marker-extension-'));
  const extensionPath = path.join(dir, 'marker');
  await fs.cp(markerExtensionPath, extensionPath, { recursive: true });
  return extensionPath;
}

async function createTabAndWaitForExpression<T>(
  app: Awaited<ReturnType<typeof launchTestApp>>['app'],
  url: string,
  expression: string,
): Promise<T> {
  return await app.evaluate(async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: args.url,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const wc = wf.tabs.getWebContents(rec.id);
    const start = Date.now();
    let last: unknown;
    while (Date.now() - start < 5000) {
      last = await wc.executeJavaScript(args.expression).catch((e: unknown) => String(e));
      if (last) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last as T;
  }, { url, expression });
}

test('fixture extension content script marks a file page', async () => {
  const { app } = await launchTestApp({
    extensions: [{ path: markerExtensionPath, allowFileAccess: true }],
  });

  const marker = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerExtension',
  );

  expect(marker).toBe('loaded');
  await app.close();
});

test('fixture extension resource loads via chrome-extension URL', async () => {
  const { app } = await launchTestApp({
    extensions: [{ path: markerExtensionPath, allowFileAccess: true }],
  });

  const extensionId = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).wf._debug.extensions[0].id as string;
  });
  const body = await createTabAndWaitForExpression<string>(
    app,
    `chrome-extension://${extensionId}/resource.html`,
    'document.body?.textContent?.trim()',
  );

  expect(body).toBe('fixture extension resource loaded');
  await app.close();
});

test('fixture extension content script round-trips through background service worker', async () => {
  const { app } = await launchTestApp({
    extensions: [{ path: markerExtensionPath, allowFileAccess: true }],
  });

  const response = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerRuntimeResponse',
  );
  const diagnostics = await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).wf._debug.extensionDiagnostics();
  });

  expect(response).toBe('webframe-fixture-pong');
  expect(diagnostics.loaded[0].name).toBe('WebFrame Marker Fixture');
  expect(
    diagnostics.events.some(
      (event: { type: string; scope?: string }) =>
        event.type === 'service-worker-registration-completed' &&
        event.scope?.startsWith('chrome-extension://'),
    ),
  ).toBe(true);
  await app.close();
});

test('fixture extension storage writes and reads during the app session', async () => {
  const { app } = await launchTestApp({
    extensions: [{ path: markerExtensionPath, allowFileAccess: true }],
  });

  const value = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerStorageValue',
  );

  expect(value).toBe('stored-from-content-script');
  await app.close();
});

test('fixture extension sends one native message to the fake host', async () => {
  const manifestPath = await createFakeNativeHostManifest();
  const extensionPath = await copyMarkerExtensionFixture();
  const { app } = await launchTestApp({
    extensions: [{ path: extensionPath, allowFileAccess: true }],
    nativeMessaging: { hosts: [{ manifestPath, allowedExtensionIds: [markerExtensionId] }] },
  });

  const value = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerNativeEcho',
  );

  expect(value).toBe('native-single');
  await app.close();
});

test('fixture extension opens a native port and disconnects cleanly', async () => {
  const manifestPath = await createFakeNativeHostManifest();
  const extensionPath = await copyMarkerExtensionFixture();
  const { app } = await launchTestApp({
    extensions: [{ path: extensionPath, allowFileAccess: true }],
    nativeMessaging: { hosts: [{ manifestPath, allowedExtensionIds: [markerExtensionId] }] },
  });

  const stream = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerNativeStream',
  );
  const disconnected = await createTabAndWaitForExpression<string>(
    app,
    targetPageUrl,
    'document.documentElement.dataset.webframeMarkerNativeDisconnected',
  );

  expect(stream).toBe('stream-1,stream-2,stream-3');
  expect(disconnected).toBe('true');
  await app.close();
});

test('fixture extension action click handler can be triggered from WebFrame', async () => {
  const extensionPath = await copyMarkerExtensionFixture();
  const { app } = await launchTestApp({
    extensions: [{ path: extensionPath, allowFileAccess: true }],
  });

  const value = await app.evaluate(async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: args.targetPageUrl,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const targetWc = wf.tabs.getWebContents(rec.id);
    const targetStart = Date.now();
    while (Date.now() - targetStart < 5000) {
      const href = await targetWc.executeJavaScript('location.href').catch(() => '');
      if (href === args.targetPageUrl) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await wf.extensions.triggerAction(args.extensionId, { tabId: rec.id });
    const queryRec = await wf.caller.tabs.create({
      url: `chrome-extension://${args.extensionId}/resource.html`,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const wc = wf.tabs.getWebContents(queryRec.id);
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const result = await wc.executeJavaScript(`new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'webframe-fixture-get-action-click' }, resolve);
      })`);
      if (result && result !== 'missing') return result;
      await new Promise((r) => setTimeout(r, 50));
    }
    return 'missing';
  }, { targetPageUrl, extensionId: markerExtensionId });

  expect(value).toBe(`clicked:${targetPageUrl}`);
  await app.close();
});
