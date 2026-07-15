const assert = require('node:assert/strict');
const path = require('node:path');
const {
  createExtensionDiagnostics,
  loadWebframeExtensions,
} = require('../dist/extensions.js');

async function rejectsWithCode(fn, code) {
  await assert.rejects(fn, (err) => err && err.code === code);
}

(async () => {
  let loadCalls = 0;
  const persistentSession = {
    isPersistent: () => true,
    loadExtension: async (extensionPath) => {
      loadCalls += 1;
      return { id: 'fixture-id', name: 'Fixture', path: extensionPath };
    },
  };
  const fixturePath = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'extensions', 'marker');

  const loaded = await loadWebframeExtensions({
    session: persistentSession,
    sessionSource: 'persist:test',
    extensions: [fixturePath],
  });
  assert.deepEqual(loaded, [{ id: 'fixture-id', name: 'Fixture', path: fixturePath }]);
  assert.equal(loadCalls, 1);

  loadCalls = 0;
  await rejectsWithCode(
    () =>
      loadWebframeExtensions({
        session: persistentSession,
        sessionSource: 'persist:test',
        extensions: ['relative-extension-path'],
      }),
    'EXTENSION_PATH_INVALID',
  );
  assert.equal(loadCalls, 0);

  await rejectsWithCode(
    () =>
      loadWebframeExtensions({
        session: persistentSession,
        sessionSource: 'memory:test',
        extensions: [fixturePath],
      }),
    'EXTENSIONS_REQUIRE_PERSISTENT_SESSION',
  );
  assert.equal(loadCalls, 0);

  await rejectsWithCode(
    () =>
      loadWebframeExtensions({
        session: { isPersistent: () => false, loadExtension: async () => ({}) },
        sessionSource: {},
        extensions: [fixturePath],
      }),
    'EXTENSIONS_REQUIRE_PERSISTENT_SESSION',
  );

  await rejectsWithCode(
    () =>
      loadWebframeExtensions({
        session: { isPersistent: () => true },
        sessionSource: {},
        extensions: [fixturePath],
      }),
    'EXTENSIONS_UNSUPPORTED_SESSION',
  );

  const diagnostics = createExtensionDiagnostics();
  const electronFailure = new Error('electron load failed');
  await assert.rejects(
    () =>
      loadWebframeExtensions({
        session: {
          isPersistent: () => true,
          loadExtension: async () => {
            throw electronFailure;
          },
          on() {},
          serviceWorkers: { on() {} },
        },
        sessionSource: 'persist:test',
        extensions: [fixturePath],
        diagnostics,
      }),
    (err) => err === electronFailure,
  );
  assert.deepEqual(diagnostics.events, [
    { type: 'extension-load-failed', path: fixturePath, error: 'electron load failed' },
  ]);

  console.log('extensions unit ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
