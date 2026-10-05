import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { placeholderPhotoSvg } from '@photobooth/ui';
import { CameraError, status, type CameraProvider, type CameraStatus, type CapturedPhoto } from '../index';

export interface CaptureMeta {
  sessionId?: string;
  sessionCode?: string;
  angle?: number;
  shot?: number;
}

/** Server-side camera driver: a CameraProvider producing Buffers, optionally with MJPEG live view. */
export interface ServerCameraDriver extends CameraProvider<Buffer> {
  readonly name: string;
  readonly supportsPreview: boolean;
  capture(meta?: CaptureMeta): Promise<CapturedPhoto<Buffer>>;
  /** Live-view JPEG frames. Returns an unsubscribe function. */
  subscribePreview(onFrame: (jpeg: Buffer) => void): () => void;
  /** Development fault injection. */
  simulateFailure(mode: 'capture' | 'disconnect' | null): void;
}

type FailureMode = 'capture' | 'disconnect' | null;

abstract class BaseDriver implements ServerCameraDriver {
  abstract readonly name: string;
  abstract readonly supportsPreview: boolean;
  protected st: CameraStatus;
  protected failure: FailureMode = null;
  protected subscribers = new Set<(f: Buffer) => void>();

  constructor(driver: string) {
    this.st = status(driver, 'disconnected');
  }

  getStatus(): CameraStatus {
    return this.st;
  }

  protected set(state: CameraStatus['state'], extra: Partial<CameraStatus> = {}) {
    this.st = status(this.name, state, { model: this.st.model, ...extra });
  }

  simulateFailure(mode: FailureMode): void {
    this.failure = mode;
    if (mode === 'disconnect') this.set('error', { lastError: 'Simulated disconnect' });
    else if (this.st.state === 'error') this.set('ready');
  }

  protected checkFailure() {
    if (this.failure === 'disconnect') throw new CameraError('CAMERA_DISCONNECTED', 'Camera disconnected (simulated)');
    if (this.failure === 'capture') throw new CameraError('CAMERA_SIMULATED_FAILURE', 'Capture failed (simulated)');
  }

  abstract connect(): Promise<void>;
  abstract capture(meta?: CaptureMeta): Promise<CapturedPhoto<Buffer>>;

  async disconnect(): Promise<void> {
    await this.stopPreview();
    this.set('disconnected');
  }

  async startPreview(): Promise<void> {
    /* drivers with live view override */
  }

  async stopPreview(): Promise<void> {
    /* drivers with live view override */
  }

  subscribePreview(onFrame: (jpeg: Buffer) => void): () => void {
    this.subscribers.add(onFrame);
    if (this.subscribers.size === 1) void this.startPreview().catch(() => undefined);
    return () => {
      this.subscribers.delete(onFrame);
      if (this.subscribers.size === 0) void this.stopPreview().catch(() => undefined);
    };
  }

  protected emitFrame(frame: Buffer) {
    for (const s of this.subscribers) s(frame);
  }
}

// ------------------------------------------------------------------ mock

/**
 * Mock camera: renders the prototype placeholder illustration as a real
 * 2400×1800 JPEG so the complete pipeline can be exercised without hardware.
 */
export class MockCameraDriver extends BaseDriver {
  readonly name = 'mock';
  readonly supportsPreview = false;

  constructor(private readonly opts: { width?: number; height?: number; delayMs?: number } = {}) {
    super('mock');
  }

  async connect(): Promise<void> {
    if (this.failure === 'disconnect') throw new CameraError('CAMERA_DISCONNECTED', 'Camera disconnected (simulated)');
    this.set('ready', { model: 'Mock Camera 2400×1800' });
  }

  async capture(meta: CaptureMeta = {}): Promise<CapturedPhoto<Buffer>> {
    this.checkFailure();
    this.set('capturing');
    const width = this.opts.width ?? 2400;
    const height = this.opts.height ?? 1800;
    const a = meta.angle ?? 0;
    const s = meta.shot ?? 0;
    const seed = `${a}_${s}${meta.sessionCode ? '-' + meta.sessionCode : ''}`;
    const caption = `MOCK · Sudut ${String(a + 1).padStart(2, '0')} · Foto ${s + 1}`;
    const svg = placeholderPhotoSvg(seed, width, height, caption);
    const sharp = (await import('sharp')).default;
    const data = await sharp(Buffer.from(svg)).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    this.set('ready');
    return { data, mimeType: 'image/jpeg', width, height, capturedAt: new Date(), source: 'mock' };
  }
}

// ------------------------------------------------------------------ helpers

export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of cmd.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CameraError('CAMERA_TIMEOUT', `${path.basename(bin)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CameraError('CAMERA_NOT_FOUND', `Cannot start ${bin}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** Incremental MJPEG / concatenated-JPEG splitter (SOI 0xFFD8 … EOI 0xFFD9). */
export class JpegStreamSplitter {
  private buf = Buffer.alloc(0);
  constructor(
    private readonly onFrame: (f: Buffer) => void,
    private readonly maxBuffer = 16 * 1024 * 1024,
  ) {}

  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const soi = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      const eoi = this.buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) {
        if (soi > 0) this.buf = this.buf.subarray(soi);
        if (this.buf.length > this.maxBuffer) this.buf = Buffer.alloc(0);
        return;
      }
      this.onFrame(Buffer.from(this.buf.subarray(soi, eoi + 2)));
      this.buf = this.buf.subarray(eoi + 2);
    }
  }
}

async function tmpFile(ext: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'photobooth-camera');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`);
}

// ------------------------------------------------------------------ gPhoto2 (Linux/macOS DSLR & mirrorless)

export class GPhoto2CameraDriver extends BaseDriver {
  readonly name = 'gphoto2';
  readonly supportsPreview = true;
  private preview: ChildProcess | null = null;
  private busy = false;

  constructor(private readonly bin = 'gphoto2') {
    super('gphoto2');
  }

  async connect(): Promise<void> {
    this.set('connecting');
    const { stdout, code } = await run(this.bin, ['--auto-detect'], 10000);
    const lines = stdout.split(/\r?\n/).slice(2).filter((l) => l.trim());
    if (code !== 0 || lines.length === 0) {
      this.set('error', { lastError: 'No camera detected' });
      throw new CameraError('CAMERA_NOT_FOUND', 'gphoto2 did not detect a camera');
    }
    this.set('ready', { model: lines[0].replace(/\s+usb:.*$/, '').trim() });
  }

  async startPreview(): Promise<void> {
    if (this.preview || this.busy) return;
    const child = spawn(this.bin, ['--capture-movie', '--stdout'], { windowsHide: true });
    this.preview = child;
    const splitter = new JpegStreamSplitter((f) => this.emitFrame(f));
    child.stdout?.on('data', (d: Buffer) => splitter.push(d));
    child.on('close', () => {
      if (this.preview === child) this.preview = null;
    });
    child.on('error', () => {
      if (this.preview === child) this.preview = null;
    });
    this.set('previewing');
  }

  async stopPreview(): Promise<void> {
    const p = this.preview;
    if (!p) return;
    this.preview = null;
    await new Promise<void>((resolve) => {
      p.once('close', () => resolve());
      p.kill('SIGINT');
      setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 1500);
    });
    if (this.st.state === 'previewing') this.set('ready');
  }

  async capture(): Promise<CapturedPhoto<Buffer>> {
    this.checkFailure();
    this.busy = true;
    const hadPreview = !!this.preview;
    await this.stopPreview();
    this.set('capturing');
    const file = await tmpFile('jpg');
    try {
      const { code, stderr } = await run(this.bin, ['--capture-image-and-download', '--force-overwrite', '--filename', file], 30000);
      if (code !== 0) throw new CameraError('CAMERA_CAPTURE_FAILED', stderr.trim() || `gphoto2 exited with ${code}`);
      const data = await fs.readFile(file);
      this.set('ready');
      return { data, mimeType: 'image/jpeg', capturedAt: new Date(), source: 'gphoto2' };
    } catch (err) {
      this.set('error', { lastError: (err as Error).message });
      throw err;
    } finally {
      this.busy = false;
      await fs.rm(file, { force: true }).catch(() => undefined);
      if (hadPreview || this.subscribers.size) void this.startPreview().catch(() => undefined);
    }
  }
}

// ------------------------------------------------------------------ digiCamControl (Windows DSLR / mirrorless)

/**
 * digiCamControl (https://digicamcontrol.com) exposes a local web server
 * (Settings → Webserver, default port 5513). Supports Canon/Nikon/Sony bodies on Windows.
 */
export class DigiCamControlDriver extends BaseDriver {
  readonly name = 'digicamcontrol';
  readonly supportsPreview = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly baseUrl = 'http://127.0.0.1:5513') {
    super('digicamcontrol');
  }

  private async get(query: string, timeoutMs = 8000): Promise<Response> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/${query}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new CameraError('CAMERA_CAPTURE_FAILED', `digiCamControl HTTP ${res.status}`);
    return res;
  }

  private async getText(param: string): Promise<string> {
    return (await (await this.get(`?slc=get&param1=${encodeURIComponent(param)}&param2=`)).text()).trim();
  }

  async connect(): Promise<void> {
    this.set('connecting');
    try {
      const model = await this.getText('camera');
      this.set('ready', { model: model || 'digiCamControl camera' });
    } catch (err) {
      this.set('error', { lastError: (err as Error).message });
      throw new CameraError('CAMERA_NOT_FOUND', `digiCamControl not reachable at ${this.baseUrl}`);
    }
  }

  async startPreview(): Promise<void> {
    if (this.timer) return;
    await this.get('?CMD=LiveViewWnd_Show').catch(() => undefined);
    const tick = async () => {
      try {
        const buf = Buffer.from(await (await this.get('liveview.jpg', 2000)).arrayBuffer());
        if (buf.length > 100) this.emitFrame(buf);
      } catch {
        /* skip frame */
      }
    };
    this.timer = setInterval(tick, 80);
    this.set('previewing');
  }

  async stopPreview(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.get('?CMD=LiveViewWnd_Hide').catch(() => undefined);
    if (this.st.state === 'previewing') this.set('ready');
  }

  async capture(): Promise<CapturedPhoto<Buffer>> {
    this.checkFailure();
    this.set('capturing');
    try {
      const before = await this.getText('lastcaptured').catch(() => '');
      await this.get('?CMD=Capture', 15000);
      const deadline = Date.now() + 20000;
      let name = before;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        name = await this.getText('lastcaptured').catch(() => before);
        if (name && name !== before && name !== '-') break;
      }
      if (!name || name === before) throw new CameraError('CAMERA_TIMEOUT', 'digiCamControl did not report a new file');
      let data: Buffer;
      try {
        const folder = await this.getText('session.folder');
        data = await fs.readFile(path.isAbsolute(name) ? name : path.join(folder, name));
      } catch {
        data = Buffer.from(await (await this.get(`image/${encodeURIComponent(path.basename(name))}`, 15000)).arrayBuffer());
      }
      this.set(this.timer ? 'previewing' : 'ready');
      return { data, mimeType: 'image/jpeg', capturedAt: new Date(), source: 'digicamcontrol' };
    } catch (err) {
      this.set('error', { lastError: (err as Error).message });
      throw err instanceof CameraError ? err : new CameraError('CAMERA_CAPTURE_FAILED', (err as Error).message);
    }
  }
}

// ------------------------------------------------------------------ generic vendor SDK / CLI

/**
 * Runs any command line that writes a JPEG to `{output}`, e.g.
 *   "C:\Program Files\digiCamControl\CameraControlCmd.exe" /capture /filename {output}
 *   EDSDK / Sony Remote SDK wrappers, custom capture tools…
 * Optional MJPEG live view can be provided by `previewUrl` (IP camera / capture card bridge).
 */
export class CommandCameraDriver extends BaseDriver {
  readonly name = 'command';
  readonly supportsPreview: boolean;
  private abort: AbortController | null = null;

  constructor(
    private readonly command: string,
    private readonly previewUrl = '',
    private readonly timeoutMs = 30000,
  ) {
    super('command');
    this.supportsPreview = !!previewUrl;
  }

  async connect(): Promise<void> {
    if (!this.command.includes('{output}')) {
      this.set('error', { lastError: 'captureCommand must contain {output}' });
      throw new CameraError('CAMERA_NOT_FOUND', 'Camera command is not configured (needs {output} placeholder)');
    }
    const bin = splitCommand(this.command)[0];
    if (path.isAbsolute(bin)) {
      try {
        await fs.access(bin);
      } catch {
        this.set('error', { lastError: `${bin} not found` });
        throw new CameraError('CAMERA_NOT_FOUND', `${bin} not found`);
      }
    }
    this.set('ready', { model: path.basename(bin) });
  }

  async startPreview(): Promise<void> {
    if (!this.previewUrl || this.abort) return;
    this.abort = new AbortController();
    const splitter = new JpegStreamSplitter((f) => this.emitFrame(f));
    try {
      const res = await fetch(this.previewUrl, { signal: this.abort.signal });
      const reader = res.body?.getReader();
      if (!reader) return;
      this.set('previewing');
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        splitter.push(Buffer.from(value));
      }
    } catch {
      /* stream ended */
    } finally {
      this.abort = null;
    }
  }

  async stopPreview(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
  }

  async capture(): Promise<CapturedPhoto<Buffer>> {
    this.checkFailure();
    this.set('capturing');
    const file = await tmpFile('jpg');
    const [bin, ...args] = splitCommand(this.command).map((a) => a.replace('{output}', file));
    try {
      const { code, stderr } = await run(bin, args, this.timeoutMs);
      if (code !== 0) throw new CameraError('CAMERA_CAPTURE_FAILED', stderr.trim() || `capture command exited with ${code}`);
      const data = await fs.readFile(file).catch(() => {
        throw new CameraError('CAMERA_CAPTURE_FAILED', 'Capture command did not produce a file');
      });
      this.set('ready');
      return { data, mimeType: 'image/jpeg', capturedAt: new Date(), source: 'command' };
    } catch (err) {
      this.set('error', { lastError: (err as Error).message });
      throw err;
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
}

export interface ServerCameraConfig {
  driver: string;
  gphoto2Bin: string;
  digicamUrl: string;
  captureCommand: string;
  previewUrl: string;
}

/** Returns null for 'webcam' (capture happens in the booth browser). */
export function createServerCamera(cfg: ServerCameraConfig): ServerCameraDriver | null {
  switch (cfg.driver) {
    case 'mock':
      return new MockCameraDriver();
    case 'gphoto2':
      return new GPhoto2CameraDriver(cfg.gphoto2Bin || 'gphoto2');
    case 'digicamcontrol':
      return new DigiCamControlDriver(cfg.digicamUrl);
    case 'command':
      return new CommandCameraDriver(cfg.captureCommand, cfg.previewUrl);
    default:
      return null;
  }
}
