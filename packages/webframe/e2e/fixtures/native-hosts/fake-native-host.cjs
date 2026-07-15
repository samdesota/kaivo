#!/usr/bin/env node
let input = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length < 4) return;
  const length = input.readUInt32LE(0);
  if (input.length < 4 + length) return;
  const message = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
  if (message.kind === 'stream') {
    writeMessage({ value: 'stream-1', input: message.value });
    writeMessage({ value: 'stream-2', input: message.value });
    writeMessage({ value: 'stream-3', input: message.value });
    return process.stdin.resume();
  }
  writeMessage({ echo: message });
  process.exit(0);
});
process.stdin.on('end', () => {
  if (input.length < 4) process.exit(1);
});

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
