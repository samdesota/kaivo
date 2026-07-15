const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  NativeMessageParser,
  encodeNativeMessage,
  installExperimentalNativeMessagingBridge,
  readNativeMessagingHostManifest,
} = require('../dist/native-messaging.js');

async function rejectsWithCode(fn, code) {
  await assert.rejects(fn, (err) => err && err.code === code);
}

async function writeManifest(fields) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webframe-native-unit-'));
  const manifestPath = path.join(dir, 'host.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      name: 'com.webframe.unit_host',
      path: process.execPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
      ...fields,
    }),
  );
  return manifestPath;
}

(async () => {
  await rejectsWithCode(
    () => readNativeMessagingHostManifest('relative-manifest.json'),
    'NATIVE_MESSAGING_MANIFEST_INVALID',
  );
  const relativeHostManifest = await writeManifest({ path: 'relative-host' });
  await rejectsWithCode(
    () => readNativeMessagingHostManifest(relativeHostManifest),
    'NATIVE_MESSAGING_MANIFEST_INVALID',
  );
  const socketManifest = await writeManifest({ type: 'socket' });
  await rejectsWithCode(
    () => readNativeMessagingHostManifest(socketManifest),
    'NATIVE_MESSAGING_MANIFEST_INVALID',
  );
  const missingOriginManifest = await writeManifest({ allowed_origins: [] });
  await rejectsWithCode(
    () => readNativeMessagingHostManifest(missingOriginManifest),
    'NATIVE_MESSAGING_MANIFEST_INVALID',
  );

  const disallowedManifest = await writeManifest({});
  await rejectsWithCode(
    () =>
      installExperimentalNativeMessagingBridge({
        nativeMessaging: {
          hosts: [
            {
              manifestPath: disallowedManifest,
              allowedExtensionIds: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
            },
          ],
        },
        loadedExtensions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      }),
    'NATIVE_MESSAGING_EXTENSION_DISALLOWED',
  );

  const message = { ok: true, value: 42 };
  const frame = encodeNativeMessage(message);
  const parser = new NativeMessageParser();
  assert.deepEqual(parser.push(frame.subarray(0, 3)), []);
  assert.deepEqual(parser.push(frame.subarray(3)), [message]);

  const malformed = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('{')]);
  assert.throws(() => new NativeMessageParser().push(malformed), (err) => {
    assert.equal(err.code, 'NATIVE_MESSAGING_FRAME_INVALID');
    return true;
  });

  console.log('native messaging unit ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
