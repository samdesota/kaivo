import { test, expect } from '@playwright/test';
import { launchTestApp } from './fixtures';

test.describe.configure({ mode: 'serial' });

const onePasswordExtensionPath = process.env.WEBFRAME_1PASSWORD_EXTENSION_PATH;
const onePasswordNativeHostManifest = process.env.WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST;
const onePasswordExtensionId = process.env.WEBFRAME_1PASSWORD_EXTENSION_ID ?? 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';

async function collectOnePasswordProbe(app: Awaited<ReturnType<typeof launchTestApp>>['app']) {
  return await app.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    return {
      extensions: wf._debug.extensions,
      diagnostics: wf._debug.extensionDiagnostics(),
      extensionPages: wf._debug.extensionPages(),
    };
  });
}

async function openOnePasswordPopup(app: Awaited<ReturnType<typeof launchTestApp>>['app']) {
  return await app.evaluate(async (_ctx, args) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wf = (globalThis as any).wf;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windowId = (globalThis as any).mainWindowId;
    const rec = await wf.caller.tabs.create({
      url: `chrome-extension://${args.extensionId}/popup/index.html`,
      windowId,
      placement: { slot: 'content' },
      active: true,
    });
    const wc = wf.tabs.getWebContents(rec.id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await wc.executeJavaScript(`({
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 1000) ?? '',
      htmlLength: document.documentElement.outerHTML.length,
    })`);
  }, { extensionId: onePasswordExtensionId });
}

test('local opt-in loads the unpacked 1Password extension and records Electron diagnostics', async () => {
  test.skip(!onePasswordExtensionPath, 'set WEBFRAME_1PASSWORD_EXTENSION_PATH to an unpacked 1Password extension directory');

  const { app } = await launchTestApp({
    extensions: [{ path: onePasswordExtensionPath!, allowFileAccess: true }],
    chromeExtensions: { enabled: true, license: 'GPL-3.0' },
  });

  try {
    const popup = await openOnePasswordPopup(app);
    const probe = await collectOnePasswordProbe(app);
    const loaded = probe.extensions.find((extension: { id: string }) => extension.id === onePasswordExtensionId);

    console.log(JSON.stringify({ onePasswordProbe: probe, onePasswordPopup: popup }, null, 2));
    expect(loaded).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('local opt-in attempts 1Password native messaging when the host manifest exists', async () => {
  test.skip(!onePasswordExtensionPath, 'set WEBFRAME_1PASSWORD_EXTENSION_PATH to an unpacked 1Password extension directory');
  test.skip(!onePasswordNativeHostManifest, 'set WEBFRAME_1PASSWORD_NATIVE_HOST_MANIFEST to com.1password.1password.json');

  const { app } = await launchTestApp({
    extensions: [{ path: onePasswordExtensionPath!, allowFileAccess: true }],
    chromeExtensions: { enabled: true, license: 'GPL-3.0' },
    nativeMessaging: {
      hosts: [
        { manifestPath: onePasswordNativeHostManifest!, allowedExtensionIds: [onePasswordExtensionId] },
        { manifestPath: onePasswordNativeHostManifest!, hostName: 'com.1password.1password7', allowedExtensionIds: [onePasswordExtensionId] },
      ],
    },
  });

  try {
    const popup = await openOnePasswordPopup(app);
    const probe = await collectOnePasswordProbe(app);
    console.log(JSON.stringify({ onePasswordNativeMessagingProbe: { mode: 'extension-runtime' }, onePasswordPopup: popup, onePasswordProbe: probe }, null, 2));
    expect(probe.extensions.some((extension: { id: string }) => extension.id === onePasswordExtensionId)).toBe(true);
  } finally {
    await app.close();
  }
});
