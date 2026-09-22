import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERROR_CODES, FrameDecoder, ProtocolError, encodeFrame, errorDetailsSchema, parseMessage } from '../packages/protocol/src/index.js';

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

const response = (overrides: Record<string, unknown> = {}) => ({
  v: 1, type: 'response', id: 'r-1', session_id: 's-1', command: 'arm.joint.jog',
  robot_time_ms: 42, ok: false, code: 'LIMIT_REACHED', msg: 'Joint limit reached', data: {},
  ...overrides,
});

test('accepts only registered response codes or X_ extension codes', () => {
  assert.ok(ERROR_CODES.includes('IK_FAILED'));
  assert.equal(parseMessage(response()).code, 'LIMIT_REACHED');
  assert.equal(parseMessage(response({ code: 'X_VENDOR_SERVO_FAULT' })).code, 'X_VENDOR_SERVO_FAULT');
  assert.throws(() => parseMessage(response({ code: 'JOINT_LMIT' })), /code/i);
});

test('requires response ok and code to agree', () => {
  assert.equal(parseMessage(response({ ok: true, code: 'OK' })).code, 'OK');
  assert.throws(() => parseMessage(response({ ok: true, code: 'LIMIT_REACHED' })), /OK code|code/i);
  assert.throws(() => parseMessage(response({ ok: false, code: 'OK' })), /OK code|code/i);
});

test('validates structured error details', () => {
  const details = {
    category: 'safety', stage: 'admission', component: 'left_arm', arm: 'left', joint: 3,
    direction: 'positive', limit_type: 'soft_position', current: 2.8, min: -2.9, max: 2.8,
    requested: 0.2, unit: 'rad', retryable: true, action: 'reverse_direction',
  };
  assert.equal(errorDetailsSchema.parse(details).joint, 3);
  assert.equal(parseMessage(response({ data: { error: details } })).code, 'LIMIT_REACHED');
  assert.throws(() => parseMessage(response({ data: { error: { ...details, joint: 8 } } })), /joint/i);
});

test('requires terminal result phase and code to agree', () => {
  const result = { v: 1, type: 'result', session_id: 's-1', robot_time_ms: 50, motion_id: 'm-1', phase: 'failed', code: 'IK_FAILED', msg: 'IK failed', data: {} };
  assert.equal(parseMessage(result).code, 'IK_FAILED');
  assert.equal(parseMessage({ ...result, phase: 'completed', code: 'ENDPOINT_REACHED' }).code, 'ENDPOINT_REACHED');
  assert.throws(() => parseMessage({ ...result, phase: 'completed', code: 'IK_FAILED' }), /phase|code/i);
  assert.throws(() => parseMessage({ ...result, phase: 'stopped', code: 'OK' }), /phase|code/i);
});

test('the operator console has a Chinese presentation for every registered error code', () => {
  const consoleHtml = readFileSync(new URL('../apps/web/public/console.html', import.meta.url), 'utf8');
  for (const code of ERROR_CODES) assert.match(consoleHtml, new RegExp(`\\b${code}\\s*:`), `missing UI presentation for ${code}`);
});
