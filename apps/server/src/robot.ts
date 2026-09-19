import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameDecoder, makeCommand, type Response, encodeFrame } from '@robot-station/protocol';
import { config, requireRobotConfig } from './config.js';

export type RobotStatus = { mode: 'mock' | 'tcp'; connected: boolean; sessionId: string | null; robotId: string | null; lastError: string | null };

export class RobotGateway extends EventEmitter {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<string, { resolve: (response: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private status: RobotStatus = { mode: config.robotMode === 'tcp' ? 'tcp' : 'mock', connected: config.robotMode !== 'tcp', sessionId: config.robotMode === 'mock' ? 'mock-session' : null, robotId: config.robotMode === 'mock' ? 'mock-robot' : null, lastError: null };
  getStatus(): RobotStatus { return { ...this.status }; }
  async connect(): Promise<void> {
    if (this.status.mode === 'mock') return;
    const target = requireRobotConfig();
    this.socket = net.createConnection({ host: target.host, port: target.port });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('timeout', () => { if (this.decoder.hasPartialFrame()) { this.status = { ...this.status, connected: false, lastError: 'robot frame timeout' }; this.socket?.destroy(); this.emit('status', this.getStatus()); } else this.socket?.setTimeout(0); });
    this.socket.on('error', (error) => { this.status = { ...this.status, connected: false, lastError: error.message }; this.emit('status', this.getStatus()); });
    this.socket.on('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('robot connection closed')); } this.pending.clear(); this.status = { ...this.status, connected: false, sessionId: null }; this.emit('status', this.getStatus()); });
    await new Promise<void>((resolve, reject) => { this.socket!.once('connect', resolve); this.socket!.once('error', reject); });
    this.status = { ...this.status, connected: true };
    const response = await this.send('system.hello', { supported_versions: [1], client_id: 'robot-station-server', client_name: 'Robot Station', token: target.token });
    if (!response.ok) throw new Error(`Robot hello failed: ${response.code}`);
    this.status = { ...this.status, connected: true, sessionId: response.session_id, robotId: String(response.data.robot_id ?? '') || null };
    this.emit('status', this.getStatus());
  }
  disconnect(): void { this.socket?.destroy(); this.socket = null; }
  async send(command: string, params: Record<string, unknown>): Promise<Response> {
    const id = `server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.status.mode === 'mock') return this.mock(command, params, id);
    if (!this.socket || !this.status.connected) throw new Error('robot is not connected');
    const message = makeCommand(command, params, id, command === 'system.hello' ? undefined : this.status.sessionId ?? undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('robot response timeout')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(encodeFrame(message));
    });
  }
  private onData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === 'response') { const handler = this.pending.get(message.id); if (handler) { this.pending.delete(message.id); clearTimeout(handler.timer); handler.resolve(message); } }
        this.emit('message', message);
      }
      this.socket?.setTimeout(this.decoder.hasPartialFrame() ? 1000 : 0);
    } catch (error) {
      this.status = { ...this.status, connected: false, lastError: error instanceof Error ? error.message : String(error) };
      this.socket?.destroy(); this.emit('status', this.getStatus());
    }
  }
  private mock(command: string, params: Record<string, unknown>, id: string): Response {
    const base = { v: 1 as const, type: 'response' as const, id, session_id: 'mock-session', command, robot_time_ms: Date.now(), ok: true, code: 'OK', msg: 'Mock robot accepted the request.', data: {} };
    if (command === 'system.hello') return { ...base, data: { protocol_version: 1, robot_id: 'mock-robot', robot_name: 'Mock Robot', role: 'operator', max_frame_bytes: 65536 } };
    if (command === 'control.acquire') return { ...base, data: { lease_id: `mock-lease-${Date.now()}`, lease_expires_ms: Date.now() + 1000 } };
    if (command === 'motion.stop_all') return { ...base, data: { stop_requested: true, enabled: false } };
    if (params.motion_id) return { ...base, data: { motion_id: params.motion_id, phase: command === 'motion.keepalive' ? 'running' : 'accepted' } };
    return base;
  }
}
export const robot = new RobotGateway();