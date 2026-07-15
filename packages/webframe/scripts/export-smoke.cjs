const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const main = require(path.join(root, 'dist/index.js'));
const renderer = require(path.join(root, 'dist/renderer.js'));
const sqlite = require(path.join(root, 'sqlite/dist/index.js'));

assert.equal(typeof main.createApp, 'function', 'main export exposes createApp');
assert.equal(typeof main.createMemoryHistoryStore, 'function', 'main export exposes memory history store');
assert.equal(typeof main.createMemoryTabStore, 'function', 'main export exposes memory tab store');
assert.equal(typeof renderer, 'object', 'renderer entrypoint imports');
assert.equal(typeof sqlite.createSqliteHistoryStore, 'function', 'sqlite export exposes history store');
assert.equal(typeof sqlite.createSqliteTabStore, 'function', 'sqlite export exposes tab store');

console.log('built exports import smoke test passed');
