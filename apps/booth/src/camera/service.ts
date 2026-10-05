import { WebcamCameraProvider } from '@photobooth/camera/browser';
import { CameraError, type CameraStatus } from '@photobooth/camera';
import type { BoothConfig, SessionSnapshot } from '@photobooth/shared';
import { api } from '../api/client';

/**
 * Booth-side camera facade. The capture flow never knows which camera is used:
 *  - browser: WebcamCameraProvider (getUserMedia) grabs the frame, the booth uploads it
 *  - server/mock: the server driver (gPhoto2, digiCamControl, vendor CLI, mock) captures
 */
export interface BoothCamera {
  readonly mode: BoothConfig['camera']['mode'];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Captures and stores the photo; resolves with the updated session. */
  shoot(angle: number, shot: number, requestId: string): Promise<SessionSnapshot>;
  status(): CameraStatus;
  onStatus(cb: (s: CameraStatus) => void): () => void;
  attachVideo(el: HTMLVideoElement | null): void;
  setFault(f: 'capture' | 'disconnect' | null): void;
}

class BrowserCamera implements BoothCamera {
  readonly mode = 'browser' as const;
  private provider: WebcamCameraProvider;
  private fault: 'capture' | 'disconnect' | null = null;
  private video: HTMLVideoElement | null = null;

  constructor(cfg: BoothConfig['camera']) {
    this.provider = new WebcamCameraProvider({
      deviceId: cfg.deviceId || undefined,
      width: cfg.width,
      height: cfg.height,
      jpegQuality: cfg.jpegQuality,
      captureRotation: cfg.captureRotation,
      mirrorCapture: cfg.mirrorCapture,
    });
  }

  async start() {
    await this.provider.startPreview();
    this.provider.attach(this.video);
  }
  async stop() {
    await this.provider.stopPreview();
  }
  status() {
    const s = this.provider.getStatus();
    return this.fault === 'disconnect' ? { ...s, state: 'error' as const, lastError: 'Simulated disconnect' } : s;
  }
  onStatus(cb: (s: CameraStatus) => void) {
    return this.provider.onStatus(cb);
  }
  attachVideo(el: HTMLVideoElement | null) {
    this.video = el;
    this.provider.attach(el);
  }
  setFault(f: 'capture' | 'disconnect' | null) {
    this.fault = f;
  }

  async shoot(angle: number, shot: number, requestId: string) {
    if (this.fault === 'disconnect') throw new CameraError('CAMERA_DISCONNECTED', 'Camera disconnected (simulated)');
    if (this.fault === 'capture') throw new CameraError('CAMERA_SIMULATED_FAILURE', 'Capture failed (simulated)');
    const photo = await this.provider.capture(); // frame grabbed at the flash moment
    return api.uploadPhoto(photo.data, angle, shot, requestId);
  }
}

class ServerCamera implements BoothCamera {
  constructor(readonly mode: 'server' | 'mock') {}
  private st: CameraStatus = { driver: 'server', state: 'ready', updatedAt: new Date().toISOString() };
  async start() {}
  async stop() {}
  status() {
    return this.st;
  }
  onStatus(cb: (s: CameraStatus) => void) {
    cb(this.st);
    return () => undefined;
  }
  attachVideo() {}
  setFault() {}
  shoot(angle: number, shot: number, requestId: string) {
    return api.command({ type: 'capture', angle, shot }, { requestId, timeoutMs: 45000, retries: 2 });
  }
}

let current: BoothCamera | null = null;
let currentKey = '';

export function getCamera(cfg: BoothConfig['camera']): BoothCamera {
  const key = JSON.stringify([cfg.mode, cfg.deviceId, cfg.width, cfg.height, cfg.captureRotation, cfg.mirrorCapture, cfg.jpegQuality]);
  if (!current || key !== currentKey) {
    void current?.stop();
    current = cfg.mode === 'browser' ? new BrowserCamera(cfg) : new ServerCamera(cfg.mode === 'mock' ? 'mock' : 'server');
    currentKey = key;
  }
  return current;
}

export function cameraInstance(): BoothCamera | null {
  return current;
}
