import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, ProtocolError, encodeFrame, parseMessage } from '../packages/protocol/src/index.js';

const command = { v: 1 as const, type: 'command' as const, id: 'hello-1', command: 'system.hello', params: { supported_versions: [1], token: 'test' } };

test('encodes and decodes fragmented frames', () => {
  const frame = encodeFrame(command);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2)), [command]);
});

test('decodes multiple coalesced frames', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([encodeFrame(command), encodeFrame(command)])), [command, command]);
});

test('rejects invalid frame size and invalid message', () => {
  const decoder = new FrameDecoder();
  const badSize = Buffer.alloc(4); badSize.writeUInt32BE(65_537);
  assert.throws(() => decoder.push(badSize), ProtocolError);
  assert.throws(() => parseMessage({ v: 1, type: 'command', id: 'x', command: 'x' }), /invalid|params|required/i);
});

test('rejects duplicate JSON object keys', () => {
  const payload = Buffer.from('{\"v\":1,\"v\":1,\"type\":\"command\",\"id\":\"x\",\"command\":\"system.ping\",\"params\":{}}');
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32BE(payload.length); payload.copy(frame,4);
  assert.throws(() => new FrameDecoder().push(frame), /duplicate/i);
});

test('reports an incomplete frame', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame(command);
  decoder.push(frame.subarray(0, 3));
  assert.equal(decoder.hasPartialFrame(), true);
  decoder.push(frame.subarray(3));
  assert.equal(decoder.hasPartialFrame(), false);
});

test('rejects malformed UTF-8', () => {
  const decoder = new FrameDecoder();
  const payload = Buffer.from([0x7b,0x22,0x76,0x22,0x3a,0x31,0x2c,0xff,0x7d]);
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32BE(payload.length); payload.copy(frame,4);
  assert.throws(() => decoder.push(frame), ProtocolError);
});