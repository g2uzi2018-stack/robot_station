import { TextDecoder } from 'node:util';
import { z } from 'zod';

export const ZRCP_VERSION = 1;
export const MAX_FRAME_BYTES = 65_536;
export const MAX_JSON_DEPTH = 16;

const idSchema = z.string().regex(/^[\x21-\x7e]{1,64}$/, 'id must be 1-64 printable ASCII characters');
const paramsSchema = z.record(z.string(), z.unknown());

export const ERROR_CODES = [
  'NOT_IMPLEMENTED', 'VERSION_UNSUPPORTED', 'UNAUTHORIZED', 'AUTH_REQUIRED', 'FORBIDDEN',
  'INVALID_MESSAGE', 'INVALID_ARGUMENT', 'DUPLICATE_ID', 'SESSION_INVALID',
  'CONTROL_BUSY', 'LEASE_REQUIRED', 'LEASE_INVALID', 'LEASE_EXPIRED',
  'NOT_ENABLED', 'NOT_READY', 'NOT_HOMED', 'EMERGENCY_STOP', 'ROBOT_FAULT',
  'FEEDBACK_STALE', 'MOTION_BUSY', 'MOTION_NOT_ACTIVE', 'STALE_SEQUENCE',
  'COMMAND_EXPIRED', 'DEADLINE_INVALID', 'SPEED_LIMIT', 'LIMITS_UNAVAILABLE',
  'LIMIT_REACHED', 'FRAME_UNSUPPORTED', 'TARGET_UNREACHABLE', 'IK_FAILED',
  'SINGULARITY', 'COLLISION_RISK', 'TARGET_TIMEOUT', 'COMMAND_FAILED',
  'EXECUTOR_FAULT', 'RATE_LIMITED', 'ROBOT_UNAVAILABLE', 'ROBOT_TIMEOUT',
  'INTERNAL_ERROR',
] as const;

export const TERMINAL_CODES = [
  'ENDPOINT_REACHED', 'USER_STOP', 'STOP_ALL', 'CONTROL_RELEASED',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export const terminalCodeSchema = z.enum(TERMINAL_CODES);
export const extensionCodeSchema = z.string().regex(/^X_[A-Z][A-Z0-9_]{0,62}$/, 'extension code must use the X_ prefix');
export const protocolCodeSchema = z.union([z.literal('OK'), errorCodeSchema, terminalCodeSchema, extensionCodeSchema]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type TerminalCode = z.infer<typeof terminalCodeSchema>;
export type ProtocolCode = z.infer<typeof protocolCodeSchema>;

export const errorCategorySchema = z.enum([
  'protocol', 'authentication', 'authorization', 'control', 'safety',
  'feedback', 'planning', 'execution', 'transport', 'configuration', 'internal',
]);
export const errorStageSchema = z.enum(['admission', 'planning', 'execution', 'feedback', 'control', 'transport']);
export const recoveryActionSchema = z.enum([
  'none', 'retry', 'reverse_direction', 'reduce_speed', 'adjust_target',
  'wait_feedback', 're_enable', 'release_control', 'inspect_robot', 'reconnect',
]);

export const errorDetailsSchema = z.object({
  category: errorCategorySchema,
  stage: errorStageSchema.optional(),
  component: z.string().min(1).max(64).optional(),
  command: z.string().min(1).max(64).optional(),
  arm: z.enum(['left', 'right']).optional(),
  joint: z.number().int().min(1).max(7).optional(),
  axis: z.string().min(1).max(32).optional(),
  direction: z.enum(['positive', 'negative']).optional(),
  limit_type: z.enum(['soft_position', 'hard_position', 'velocity', 'workspace', 'unknown']).optional(),
  current: z.number().finite().optional(),
  requested: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  unit: z.string().min(1).max(16).optional(),
  feedback_age_ms: z.number().int().nonnegative().optional(),
  retryable: z.boolean(),
  action: recoveryActionSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['min'], message: 'min must not exceed max' });
  }
});
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

const dataSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (value.error === undefined) return;
  const parsed = errorDetailsSchema.safeParse(value.error);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['error', ...issue.path] });
    }
  }
});

export const commandSchema = z.object({
  v: z.literal(ZRCP_VERSION), type: z.literal('command'), id: idSchema,
  session_id: z.string().min(1).optional(), command: z.string().min(1), params: paramsSchema,
});
export const responseSchema = z.object({
  v: z.literal(ZRCP_VERSION), type: z.literal('response'), id: idSchema,
  session_id: z.string().min(1).nullable(), command: z.string().min(1), robot_time_ms: z.number().int().nonnegative(),
  ok: z.boolean(), code: protocolCodeSchema, msg: z.string().max(512), data: dataSchema,
}).superRefine((value, context) => {
  if (value.ok !== (value.code === 'OK')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'OK code must match the ok flag' });
  }
});
export const stateSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('state'), session_id: z.string().min(1), robot_time_ms: z.number().int().nonnegative(), data: z.record(z.string(), z.unknown()) });
export const eventSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('event'), session_id: z.string().min(1), robot_time_ms: z.number().int().nonnegative(), event: z.string().min(1), data: z.record(z.string(), z.unknown()) });
export const resultSchema = z.object({ v: z.literal(ZRCP_VERSION), type: z.literal('result'), session_id: z.string().min(1), request_id: idSchema.optional(), command: z.string().min(1).optional(), robot_time_ms: z.number().int().nonnegative(), motion_id: idSchema, phase: z.enum(['completed', 'stopped', 'failed']), code: protocolCodeSchema, msg: z.string().max(512), data: dataSchema }).superRefine((value, context) => {
  const completedCodes: ProtocolCode[] = ['OK', 'ENDPOINT_REACHED'];
  const stoppedCodes: ProtocolCode[] = ['USER_STOP', 'STOP_ALL', 'CONTROL_RELEASED'];
  const valid = value.phase === 'completed'
    ? completedCodes.includes(value.code)
    : value.phase === 'stopped'
      ? stoppedCodes.includes(value.code)
      : !completedCodes.includes(value.code) && !stoppedCodes.includes(value.code);
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: `code is inconsistent with ${value.phase} phase` });
});

export const messageSchema = z.union([commandSchema, responseSchema, stateSchema, eventSchema, resultSchema]);
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
