import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Physical robot abstraction (camera arm / rail / pan-tilt head).
 * The UI mascot is a separate, purely visual thing; this package moves the
 * real hardware. Angles are 1-based ids mapped to opaque physical positions
 * from configuration — no coordinates are hardcoded in the UI.
 */

export type RobotState = 'disconnected' | 'connecting' | 'idle' | 'moving' | 'homing' | 'stopped' | 'error';

export interface RobotStatus {
  state: RobotState;
  connected: boolean;
  driver: string;
  angle: number | null;
  message?: string;
  lastError?: string;
  updatedAt: string;
}

export interface RobotAngle {
  id: number;
  name: string;
  position: Record<string, unknown>;
  settleMs?: number;
}

export interface RobotController {
  readonly driver: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  home(): Promise<void>;
  moveToAngle(angle: number): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<RobotStatus>;
  setAngles(angles: RobotAngle[]): void;
}

export class RobotError extends Error {
  constructor(
    readonly code: 'ROBOT_TIMEOUT' | 'ROBOT_DISCONNECTED' | 'ROBOT_REJECTED' | 'ROBOT_UNKNOWN_ANGLE' | 'ROBOT_NOT_AVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'RobotError';
  }
}

const now = () => new Date().toISOString();

abstract class BaseRobot implements RobotController {
  abstract readonly driver: string;
  protected angles = new Map<number, RobotAngle>();
  protected state: RobotState = 'disconnected';
  protected angle: number | null = null;
  protected lastError?: string;

  setAngles(angles: RobotAngle[]): void {
    this.angles = new Map(angles.map((a) => [a.id, a]));
  }

  protected positionFor(angle: number): RobotAngle {
    const a = this.angles.get(angle);
    if (!a) throw new RobotError('ROBOT_UNKNOWN_ANGLE', `Angle ${angle} is not configured`);
    return a;
  }

  async getStatus(): Promise<RobotStatus> {
    return {
      state: this.state,
      connected: !['disconnected', 'connecting', 'error'].includes(this.state),
      driver: this.driver,
      angle: this.angle,
      lastError: this.lastError,
      updatedAt: now(),
    };
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract home(): Promise<void>;
  abstract moveToAngle(angle: number): Promise<void>;
  abstract stop(): Promise<void>;
}

// ------------------------------------------------------------------ mock

export type MockRobotFault = 'timeout' | 'disconnected' | null;

/** Simulated robot: realistic move durations, fault injection for testing. */
export class MockRobotController extends BaseRobot {
  readonly driver = 'mock';
  private fault: MockRobotFault = null;

  constructor(private readonly opts: { msPerStep?: number; minMoveMs?: number; timeoutMs?: number } = {}) {
    super();
  }

  simulateFault(f: MockRobotFault) {
    this.fault = f;
    if (f === 'disconnected') {
      this.state = 'error';
      this.lastError = 'Simulated disconnect';
    } else if (this.state === 'error') this.state = 'idle';
  }

  async connect(): Promise<void> {
    if (this.fault === 'disconnected') throw new RobotError('ROBOT_DISCONNECTED', 'Robot disconnected (simulated)');
    this.state = 'idle';
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
  }

  private async travel(ms: number) {
    if (this.fault === 'disconnected') throw new RobotError('ROBOT_DISCONNECTED', 'Robot disconnected (simulated)');
    if (this.fault === 'timeout') {
      await new Promise((r) => setTimeout(r, this.opts.timeoutMs ?? 200));
      this.state = 'error';
      this.lastError = 'Move timed out (simulated)';
      throw new RobotError('ROBOT_TIMEOUT', 'Robot move timed out (simulated)');
    }
    await new Promise((r) => setTimeout(r, ms));
  }

  async home(): Promise<void> {
    this.state = 'homing';
    await this.travel(this.opts.minMoveMs ?? 300);
    this.angle = null;
    this.state = 'idle';
  }

  async moveToAngle(angle: number): Promise<void> {
    const target = this.positionFor(angle);
    this.state = 'moving';
    const steps = Math.abs((this.angle ?? 1) - angle) || 1;
    await this.travel(Math.max(this.opts.minMoveMs ?? 300, steps * (this.opts.msPerStep ?? 120)));
    if (target.settleMs) await new Promise((r) => setTimeout(r, target.settleMs));
    this.angle = angle;
    this.state = 'idle';
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}

// ------------------------------------------------------------------ line-delimited JSON protocol

/**
 * Wire protocol shared by the Serial, TCP and WebSocket drivers. One JSON object per line:
 *   → {"id":7,"cmd":"move","angle":3,"name":"Left","position":{"pan":-60,...}}
 *   ← {"id":7,"ok":true,"state":"idle","angle":3}
 *   ← {"id":7,"ok":false,"error":"limit switch"}
 * Commands: hello, home, move, stop, status. Unsolicited {"event":"status",...} lines are allowed.
 */
export interface Transport extends EventEmitter {
  open(): Promise<void>;
  close(): Promise<void>;
  send(line: string): void;
  readonly isOpen: boolean;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class JsonLineRobotController extends BaseRobot {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private buffer = '';

  constructor(
    readonly driver: string,
    private readonly transport: Transport,
    private readonly opts: { moveTimeoutMs: number; commandTimeoutMs?: number },
  ) {
    super();
    transport.on('data', (chunk: string) => this.onData(chunk));
    transport.on('close', () => {
      this.state = 'disconnected';
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RobotError('ROBOT_DISCONNECTED', 'Robot connection closed'));
      }
      this.pending.clear();
    });
    transport.on('error', (err: Error) => {
      this.lastError = err.message;
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.state === 'string') this.state = msg.state as RobotState;
      if (typeof msg.angle === 'number') this.angle = msg.angle;
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (id === null) continue;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new RobotError('ROBOT_REJECTED', String(msg.error ?? 'Robot rejected command')));
      else p.resolve(msg);
    }
    if (this.buffer.length > 1_000_000) this.buffer = '';
  }

  private request(cmd: string, extra: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.transport.isOpen) return Promise.reject(new RobotError('ROBOT_DISCONNECTED', 'Robot not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RobotError('ROBOT_TIMEOUT', `Robot did not answer "${cmd}" within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(JSON.stringify({ id, cmd, ...extra }) + '\n');
    });
  }

  async connect(): Promise<void> {
    if (this.transport.isOpen) return;
    this.state = 'connecting';
    try {
      await this.transport.open();
      await this.request('hello', {}, this.opts.commandTimeoutMs ?? 3000).catch(() => undefined);
      this.state = 'idle';
    } catch (err) {
      this.state = 'error';
      this.lastError = (err as Error).message;
      throw new RobotError('ROBOT_DISCONNECTED', `Cannot connect to robot: ${(err as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.state = 'disconnected';
  }

  async home(): Promise<void> {
    this.state = 'homing';
    await this.request('home', {}, this.opts.moveTimeoutMs);
    this.angle = null;
    this.state = 'idle';
  }

  async moveToAngle(angle: number): Promise<void> {
    const a = this.positionFor(angle);
    this.state = 'moving';
    try {
      await this.request('move', { angle, name: a.name, position: a.position }, this.opts.moveTimeoutMs);
      this.angle = angle;
      this.state = 'idle';
      if (a.settleMs) await new Promise((r) => setTimeout(r, a.settleMs));
    } catch (err) {
      this.state = 'error';
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.request('stop', {}, this.opts.commandTimeoutMs ?? 3000);
    this.state = 'stopped';
  }

  async getStatus(): Promise<RobotStatus> {
    if (this.transport.isOpen && !['moving', 'homing'].includes(this.state)) {
      await this.request('status', {}, this.opts.commandTimeoutMs ?? 2000).catch((e) => {
        this.lastError = (e as Error).message;
      });
    }
    return super.getStatus();
  }
}

export class TcpTransport extends EventEmitter implements Transport {
  private socket: net.Socket | null = null;
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    super();
  }
  get isOpen() {
    return !!this.socket && !this.socket.destroyed;
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      s.setEncoding('utf8');
      s.setKeepAlive(true, 5000);
      const fail = (e: Error) => reject(e);
      s.once('error', fail);
      s.setTimeout(5000, () => s.destroy(new Error('TCP connect timeout')));
      s.once('connect', () => {
        s.setTimeout(0);
        s.off('error', fail);
        s.on('error', (e) => this.emit('error', e));
        s.on('data', (d) => this.emit('data', d));
        s.on('close', () => this.emit('close'));
        this.socket = s;
        resolve();
      });
    });
  }
  async close() {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
  send(line: string) {
    this.socket?.write(line);
  }
}

export class WebSocketTransport extends EventEmitter implements Transport {
  private ws: import('ws').WebSocket | null = null;
  constructor(private readonly url: string) {
    super();
  }
  get isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }
  async open(): Promise<void> {
    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 5000 });
      ws.once('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (d) => this.emit('data', d.toString().endsWith('\n') ? d.toString() : d.toString() + '\n'));
      ws.on('close', () => this.emit('close'));
    });
  }
  async close() {
    this.ws?.close();
    this.ws = null;
  }
  send(line: string) {
    this.ws?.send(line.trimEnd());
  }
}

export class SerialTransport extends EventEmitter implements Transport {
  private port: { isOpen: boolean; write(d: string): void; close(cb?: () => void): void } | null = null;
  constructor(
    private readonly path: string,
    private readonly baudRate: number,
  ) {
    super();
  }
  get isOpen() {
    return !!this.port?.isOpen;
  }
  async open(): Promise<void> {
    let mod: { SerialPort: new (o: { path: string; baudRate: number; autoOpen: boolean }) => any };
    try {
      mod = (await import('serialport')) as never;
    } catch {
      throw new RobotError('ROBOT_NOT_AVAILABLE', 'The "serialport" package is not installed (npm i serialport -w @photobooth/robot)');
    }
    const port = new mod.SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((err: Error | null) => (err ? reject(err) : resolve())));
    port.setEncoding?.('utf8');
    port.on('data', (d: Buffer | string) => this.emit('data', d.toString()));
    port.on('close', () => this.emit('close'));
    port.on('error', (e: Error) => this.emit('error', e));
    this.port = port;
  }
  async close() {
    await new Promise<void>((r) => (this.port ? this.port.close(() => r()) : r()));
    this.port = null;
  }
  send(line: string) {
    this.port?.write(line);
  }
}

// ------------------------------------------------------------------ REST

/**
 * REST controller: POST {url}/home, POST {url}/move {angle,name,position},
 * POST {url}/stop, GET {url}/status → {state, angle}.
 * The move request must return when the robot has arrived (or 4xx/5xx on failure).
 */
export class RestRobotController extends BaseRobot {
  readonly driver = 'rest';
  constructor(
    private readonly url: string,
    private readonly opts: { moveTimeoutMs: number; token?: string },
  ) {
    super();
  }

  private async call(method: string, p: string, body?: unknown, timeoutMs = 5000): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/+$/, '')}${p}`, {
        method,
        headers: { 'content-type': 'application/json', ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError') throw new RobotError('ROBOT_TIMEOUT', `Robot REST ${p} timed out`);
      throw new RobotError('ROBOT_DISCONNECTED', `Robot REST unreachable: ${e.message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.ok === false) throw new RobotError('ROBOT_REJECTED', String(json.error ?? `HTTP ${res.status}`));
    if (typeof json.state === 'string') this.state = json.state as RobotState;
    if (typeof json.angle === 'number') this.angle = json.angle;
    return json;
  }

  async connect() {
    this.state = 'connecting';
    try {
      await this.call('GET', '/status');
      if (this.state === 'connecting') this.state = 'idle';
    } catch (err) {
      this.state = 'error';
      this.lastError = (err as Error).message;
      throw err;
    }
  }
  async disconnect() {
    this.state = 'disconnected';
  }
  async home() {
    this.state = 'homing';
    await this.call('POST', '/home', {}, this.opts.moveTimeoutMs);
    this.state = 'idle';
    this.angle = null;
  }
  async moveToAngle(angle: number) {
    const a = this.positionFor(angle);
    this.state = 'moving';
    try {
      await this.call('POST', '/move', { angle, name: a.name, position: a.position }, this.opts.moveTimeoutMs);
      this.state = 'idle';
      this.angle = angle;
      if (a.settleMs) await new Promise((r) => setTimeout(r, a.settleMs));
    } catch (err) {
      this.state = 'error';
      this.lastError = (err as Error).message;
      throw err;
    }
  }
  async stop() {
    await this.call('POST', '/stop', {});
    this.state = 'stopped';
  }
  async getStatus(): Promise<RobotStatus> {
    if (!['moving', 'homing'].includes(this.state)) {
      await this.call('GET', '/status').catch((e) => {
        this.state = 'error';
        this.lastError = (e as Error).message;
      });
    }
    return super.getStatus();
  }
}

// ------------------------------------------------------------------ MQTT

/**
 * MQTT controller: publishes `{id,cmd,...}` to `<topic>/cmd`, expects replies on
 * `<topic>/resp` with the same id (same JSON as the line protocol).
 */
export class MqttTransport extends EventEmitter implements Transport {
  private client: { connected: boolean; publish(t: string, m: string): void; end(f?: boolean): void } | null = null;
  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly auth: { username?: string; password?: string } = {},
  ) {
    super();
  }
  get isOpen() {
    return !!this.client?.connected;
  }
  async open(): Promise<void> {
    let mqtt: { connect: (url: string, o: object) => any };
    try {
      mqtt = (await import('mqtt')) as never;
    } catch {
      throw new RobotError('ROBOT_NOT_AVAILABLE', 'The "mqtt" package is not installed');
    }
    const connectFn = mqtt.connect ?? (mqtt as unknown as { default: { connect: typeof mqtt.connect } }).default.connect;
    await new Promise<void>((resolve, reject) => {
      const c = connectFn(this.url, { ...this.auth, connectTimeout: 5000, reconnectPeriod: 2000 });
      c.once('connect', () => {
        c.subscribe(`${this.topic}/resp`);
        this.client = c;
        resolve();
      });
      c.once('error', reject);
      c.on('message', (_t: string, m: Buffer) => this.emit('data', m.toString() + '\n'));
      c.on('close', () => this.emit('close'));
    });
  }
  async close() {
    this.client?.end(true);
    this.client = null;
  }
  send(line: string) {
    this.client?.publish(`${this.topic}/cmd`, line.trimEnd());
  }
}

// ------------------------------------------------------------------ factory

export interface RobotConfig {
  driver: 'mock' | 'serial' | 'tcp' | 'websocket' | 'rest' | 'mqtt';
  host: string;
  port: number;
  serialPort: string;
  baudRate: number;
  url: string;
  mqttTopic: string;
  moveTimeoutMs: number;
  token?: string;
  mqttUsername?: string;
  mqttPassword?: string;
}

export function createRobotController(cfg: RobotConfig): RobotController {
  const opts = { moveTimeoutMs: cfg.moveTimeoutMs };
  switch (cfg.driver) {
    case 'serial':
      return new JsonLineRobotController('serial', new SerialTransport(cfg.serialPort, cfg.baudRate), opts);
    case 'tcp':
      return new JsonLineRobotController('tcp', new TcpTransport(cfg.host, cfg.port), opts);
    case 'websocket':
      return new JsonLineRobotController('websocket', new WebSocketTransport(cfg.url || `ws://${cfg.host}:${cfg.port}`), opts);
    case 'rest':
      return new RestRobotController(cfg.url || `http://${cfg.host}:${cfg.port}`, { ...opts, token: cfg.token });
    case 'mqtt':
      return new JsonLineRobotController(
        'mqtt',
        new MqttTransport(cfg.url || `mqtt://${cfg.host}:${cfg.port || 1883}`, cfg.mqttTopic, {
          username: cfg.mqttUsername,
          password: cfg.mqttPassword,
        }),
        opts,
      );
    case 'mock':
    default:
      return new MockRobotController();
  }
}
