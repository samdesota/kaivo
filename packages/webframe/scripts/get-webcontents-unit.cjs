const assert = require('node:assert/strict');
const { TabManager } = require('../dist/tab.js');

const manager = new TabManager({
  tabStore: {},
  historyStore: {},
  bus: {},
  session: {},
  logger: { warn() {}, error() {} },
  registerCaller() {},
  unregisterCaller() {},
  getWindowLayout() {},
  insertTabView() {},
  attachTabToWindow() {},
  detachTabFromWindow() {},
});

assert.equal(manager.getWebContents('missing'), undefined);

const liveWebContents = { id: 123, isDestroyed: () => false };
const destroyedWebContents = { id: 456, isDestroyed: () => true };

manager.tabs = new Map([
  ['live', { view: { webContents: liveWebContents } }],
  ['detached', { view: null }],
  ['destroyed', { view: { webContents: destroyedWebContents } }],
]);

assert.equal(manager.getWebContents('live'), liveWebContents);
assert.equal(manager.getWebContents('detached'), undefined);
assert.equal(manager.getWebContents('destroyed'), undefined);

console.log('getWebContents unit ok');
