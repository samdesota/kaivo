chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'webframe-fixture-ping') {
    chrome.storage.local.set({ webframeFixtureStorageValue: message.value }, () => {
      chrome.storage.local.get('webframeFixtureStorageValue', (items) => {
        sendResponse({
          type: 'webframe-fixture-pong',
          value: items.webframeFixtureStorageValue,
        });
      });
    });
    return true;
  }
  if (message?.type === 'webframe-fixture-native-single') {
    chrome.runtime.sendNativeMessage(
      'com.webframe.fixture_native_host',
      { kind: 'single', value: 'native-single' },
      (response) => sendResponse({ value: response?.echo?.value ?? 'missing' }),
    );
    return true;
  }
  if (message?.type === 'webframe-fixture-native-stream') {
    const values = [];
    const port = chrome.runtime.connectNative('com.webframe.fixture_native_host');
    port.onMessage.addListener((nativeMessage) => {
      values.push(nativeMessage.value);
      if (values.length === 3) port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      sendResponse({ values, disconnected: true });
    });
    port.postMessage({ kind: 'stream', value: 'native-stream' });
    return true;
  }
  if (message?.type === 'webframe-fixture-get-action-click') {
    chrome.storage.local.get('webframeFixtureActionClick', (items) => {
      sendResponse(items.webframeFixtureActionClick ?? 'missing');
    });
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.set({
    webframeFixtureActionClick: tab?.url ? `clicked:${tab.url}` : 'clicked',
  });
});
