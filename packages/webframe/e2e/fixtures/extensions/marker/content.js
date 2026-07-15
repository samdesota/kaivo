document.documentElement.dataset.webframeMarkerExtension = 'loaded';

chrome.runtime.sendMessage(
  { type: 'webframe-fixture-ping', value: 'stored-from-content-script' },
  (response) => {
    document.documentElement.dataset.webframeMarkerRuntimeResponse = response?.type ?? 'missing';
    document.documentElement.dataset.webframeMarkerStorageValue = response?.value ?? 'missing';
  },
);

chrome.runtime.sendMessage({ type: 'webframe-fixture-native-single' }, (response) => {
  document.documentElement.dataset.webframeMarkerNativeEcho = response?.value ?? 'missing';
});

chrome.runtime.sendMessage({ type: 'webframe-fixture-native-stream' }, (response) => {
  document.documentElement.dataset.webframeMarkerNativeStream = (response?.values ?? []).join(',');
  document.documentElement.dataset.webframeMarkerNativeDisconnected = String(
    response?.disconnected === true,
  );
});
