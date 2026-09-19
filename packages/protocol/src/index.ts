import { TextDecoder } from 'node:util';
import { z } from 'zod';

export const ZRCP_VERSION = 1;
export const MAX_FRAME_BYTES = 65_536;
export const MAX_JSON_DEPTH = 16;

const idSchema = z.string().regex(/^[\x21-\x7e]{1,64}$/, 'id must be 1-64 printable ASCII characters');
const paramsSchema = z.record(z.string(), z.unknown());

export const commandSchema = z.object({
  v: z.literal(ZRCP_VERSION), type: z.literal('command'), id: idSchema,
  session_id: z.string().min(1).optional(), command: z.string().min(1), params: paramsSchema,
});
export const responseSchema = z.object({
  v: z.literal(ZRCP_VERSION), type: z.literal('response'), id: idSchema,
  session_id: z.string().min(1).nullable(), command: z.string().min(1), robot_time_ms: z.number().int().nonnegative(),
  ok: z.boolean(), code: z.string().min(1), msg: z.string().max(512), data: z.record(z.string(), z.unknown()),
});
export const stateSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('state'), session_id: z.string().min(1), robot_time_ms: z.number().int().nonnegative(), data: z.record(z.string(), z.unknown()) });
export const eventSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('event'), session_id: z.string().min(1), robot_time_ms: z.number().int().nonnegative(), event: z.string().min(1), data: z.record(z.string(), z.unknown()) });
export const resultSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('result'), session_id: z.string().min(1), robot_time_ms: z.number().int().nonnegative(), motion_id: idSchema, phase: z.enum(['completed', 'stopped', 'failed']), code: z.string().min(1), msg: z.string().max(512), data: z.record(z.string(), z.unknown()) });

export const messageSchema = z.discriminatedUnion('type', [commandSchema, responseSchema, stateSchema, eventSchema, resultSchema]);
export type Command = z.infer<typeof commandSchema>;
export type Response = z.infer<typeof responseSchema>;
export type StateMessage = z.infer<typeof stateSchema>;
export type EventMessage = z.infer<typeof eventSchema>;
export type ResultMessage = z.infer<typeof resultSchema>;
export type ZRCPMessage = z.infer<typeof messageSchema>;

export class ProtocolError extends Error {
  constructor(message: string, public readonly code = 'INVALID_MESSAGE') { super(message); this.name = 'ProtocolError'; }
}

function checkJsonValue(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw new ProtocolError('JSON nesting too deep');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ProtocolError('non-finite JSON number');
  if (Array.isArray(value)) { for (const child of value) checkJsonValue(child, depth + 1); return; }
  if (value && typeof value === 'object') { for (const child of Object.values(value)) checkJsonValue(child, depth + 1); }
}

// JSON.parse accepts duplicate object members and keeps only the last value.
// ZRCP rejects them so an intermediary cannot reinterpret an authenticated frame.
function hasDuplicateJsonKeys(text: string): boolean {
  let index = 0;
  const whitespace = () => { while (index < text.length && /\s/.test(text[index]!)) index += 1; };
  const string = (): string => {
    const start = index; if (text[index] !== '"') throw new Error('string expected'); index += 1;
    while (index < text.length) { const ch = text[index++]; if (ch === undefined) throw new Error('unterminated string'); if (ch === '\\') { if (index >= text.length) throw new Error('bad escape'); index += 1; } else if (ch === '"') return text.slice(start, index); else if (ch < ' ') throw new Error('control character'); }
    throw new Error('unterminated string');
  };
  const value = (): void => {
    whitespace(); const ch = text[index];
    if (ch === '"') { string(); return; }
    if (ch === '{') { object(); return; }
    if (ch === '[') { array(); return; }
    const start = index; while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index += 1;
    if (start === index) throw new Error('value expected');
  };
  const array = (): void => {
    index += 1; whitespace(); if (text[index] === ']') { index += 1; return; }
    while (true) { value(); whitespace(); if (text[index] === ']') { index += 1; return; } if (text[index++] !== ',') throw new Error('array separator expected'); whitespace(); }
  };
  const object = (): void => {
    index += 1; const keys = new Set<string>(); whitespace(); if (text[index] === '}') { index += 1; return; }
    while (true) {
      whitespace(); const encoded = string(); const key = JSON.parse(encoded) as string; if (keys.has(key)) throw new ProtocolError('duplicate JSON object key'); keys.add(key);
      whitespace(); if (text[index++] !== ':') throw new Error('object separator expected'); value(); whitespace();
      if (text[index] === '}') { index += 1; return; } if (text[index++] !== ',') throw new Error('object member separator expected');
    }
  };
  try { whitespace(); value(); whitespace(); return index !== text.length ? false : false; } catch (error) { if (error instanceof ProtocolError && error.message === 'duplicate JSON object key') return true; return false; }
}

export function parseMessage(value: unknown): ZRCPMessage {
  try { return messageSchema.parse(value); }
  catch (error) { throw new ProtocolError(error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : 'invalid ZRCP message'); }
}

export function encodeFrame(message: ZRCPMessage): Buffer {
  checkJsonValue(message);
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length < 1 || payload.length > MAX_FRAME_BYTES) throw new ProtocolError('invalid payload length');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4); return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): ZRCPMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: ZRCPMessage[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME_BYTES) throw new ProtocolError('invalid payload length');
      if (this.buffer.length < length + 4) break;
      const payload = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      let parsed: unknown;
      let jsonText: string;
      try { jsonText = new TextDecoder('utf-8', { fatal: true }).decode(payload); }
      catch { throw new ProtocolError('invalid UTF-8 or JSON'); }
      if (hasDuplicateJsonKeys(jsonText)) throw new ProtocolError('duplicate JSON object key');
      try { parsed = JSON.parse(jsonText); }
      catch { throw new ProtocolError('invalid UTF-8 or JSON'); }
      checkJsonValue(parsed); messages.push(parseMessage(parsed));
    }
    return messages;
  }
  hasPartialFrame(): boolean { return this.buffer.length > 0; }
  reset(): void { this.buffer = Buffer.alloc(0); }
}

export function makeCommand(command: string, params: Record<string, unknown>, id: string, sessionId?: string): Command {
  return commandSchema.parse({ v: ZRCP_VERSION, type: 'command', id, ...(sessionId ? { session_id: sessionId } : {}), command, params });
}