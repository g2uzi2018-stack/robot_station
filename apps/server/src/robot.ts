import net from 'node:net';
import { EventEmitter } from 'node:events';
import { FrameDecoder, makeCommand, type Response, encodeFrame } from '@robot-station/protocol';

export type RobotTarget = { host: string; port: number; token: string; profileId?: number | null; profileName?: string | null };
export type RobotStatus = { mode: 'tcp'; connected: boolean; sessionId: string | null; robotId: string | null; lastError: string | null; connectionId: number | null; connectionName: string | null; host: string | null; port: number | null };
type Pending = { resolve: (response: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class RobotGateway extends EventEmitter {
  private socket: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<string, Pending>();
  private connectPromise: Promise<void> | null = null;
  private target: RobotTarget | null = null;
  private status: RobotStatus = { mode: 'tcp', connected: false, sessionId: null, robotId: null, lastError: null, connectionId: null, connectionName: null, host: null, port: null };

  getStatus(): RobotStatus { return { ...this.status }; }
  getTarget(): RobotTarget | null { return this.target ? { ...this.target } : null; }

  async connect(target?: RobotTarget): Promise<void> {
    if (target) {
      const changed = !this.sameTarget(this.target, target);
      this.target = { ...target };
      this.status = { ...this.status, connectionId: target.profileId ?? null, connectionName: target.profileName ?? null, host: target.host, port: target.port, lastError: null };
      if (changed && (this.socket || this.status.connected)) this.disconnect();
    }
    if (this.status.connected && this.socket) return;
    if (this.connectPromise) return this.connectPromise;
    if (!this.target) throw new Error('No robot connection has been selected');
    this.connectPromise = this.openConnection().finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  private sameTarget(left: RobotTarget | null, right: RobotTarget): boolean { return Boolean(left && left.host === right.host && left.port === right.port && left.token === right.token && (left.profileId ?? null) === (right.profileId ?? null)); }

  private async openConnection(): Promise<void> {
    const target = this.target;
    if (!target) throw new Error('No robot connection has been selected');
    const socket = net.createConnection({ host: target.host, port: target.port });
    this.socket = socket;
    this.decoder = new FrameDecoder();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('timeout', () => {
      if (!this.isCurrent(socket)) return;
      if (this.decoder.hasPartialFrame()) {
        this.failConnection(socket, 'robot frame timeout');
        socket.destroy();
      } else socket.setTimeout(0);
    });
    socket.on('error', (error) => {
      if (this.isCurrent(socket)) {
        this.status = { ...this.status, connected: false, lastError: error.message };
        this.emit('status', this.getStatus());
      }
    });
    socket.on('close', () => {
      if (!this.isCurrent(socket)) return;
      this.socket = null;
      this.rejectPending(new Error('robot connection closed'));
      this.status = { ...this.status, connected: false, sessionId: null, robotId: null };
      this.emit('status', this.getStatus());
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => { socket.off('error', onError); resolve(); };
        const onError = (error: Error) => { socket.off('connect', onConnect); reject(error); };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
      if (!this.isCurrent(socket)) throw new Error('robot connection was replaced');
      this.status = { ...this.status, connected: true, lastError: null };
      const response = await this.send('system.hello', { supported_versions: [1], client_id: 'robot-station-server', client_name: 'Robot Station', token: target.token });
      if (!response.ok) throw new Error(`Robot hello failed: ${response.code}`);
      this.status = { ...this.status, connected: true, sessionId: response.session_id, robotId: String(response.data.robot_id ?? '') || null, lastError: null };
      this.emit('status', this.getStatus());
    } catch (error) {
      if (this.isCurrent(socket)) {
        this.socket = null;
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        this.status = { ...this.status, connected: false, sessionId: null, robotId: null, lastError: error instanceof Error ? error.message : String(error) };
        this.emit('status', this.getStatus());
      }
      socket.destroy();
      throw error;
    }
  }

  private isCurrent(socket: net.Socket): boolean { return this.socket === socket; }
  private failConnection(socket: net.Socket, message: string): void { if (!this.isCurrent(socket)) return; this.status = { ...this.status, connected: false, lastError: message }; this.rejectPending(new Error(message)); this.emit('status', this.getStatus()); }
  private rejectPending(error: Error): void { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new Error('robot connection closed'));
    socket?.destroy();
    this.status = { ...this.status, connected: false, sessionId: null, robotId: null };
    this.emit('status', this.getStatus());
  }

  async reconnect(target?: RobotTarget): Promise<void> {
    const inFlight = this.connectPromise;
    if (target) {
      this.target = { ...target };
      this.status = { ...this.status, connectionId: target.profileId ?? null, connectionName: target.profileName ?? null, host: target.host, port: target.port, lastError: null };
    }
    this.disconnect();
    if (inFlight) { try { await inFlight; } catch {} }
    await this.connect();
  }

  async send(command: string, params: Record<string, unknown>): Promise<Response> {
    const socket = this.socket;
    if (!socket || !this.status.connected) throw new Error('robot is not connected');
    const id = `server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = makeCommand(command, params, id, command === 'system.hello' ? undefined : this.status.sessionId ?? undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('robot response timeout')); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeFrame(message), (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id); clearTimeout(item.timer); item.reject(error);
      });
    });
  }

  private onData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === 'response') {
          const handler = this.pending.get(message.id);
          if (handler) { this.pending.delete(message.id); clearTimeout(handler.timer); handler.resolve(message); }
        }
        this.emit('message', message);
      }
      this.socket?.setTimeout(this.decoder.hasPartialFrame() ? 1000 : 0);
    } catch (error) {
      const socket = this.socket;
      if (socket) this.failConnection(socket, error instanceof Error ? error.message : String(error));
      socket?.destroy();
    }
  }
}
export const robot = new RobotGateway();
