import { CameraError, status, type CameraProvider, type CameraStatus, type CapturedPhoto } from '../index';

/** Frames smaller than this come from a dropping stream and are rejected. */
const MIN_FRAME = 64;

export interface WebcamOptions {
  deviceId?: string;
  width: number;
  height: number;
  /** 0..1 */
  jpegQuality: number;
  /** Rotate the saved photo (camera mounted sideways / upside down). */
  captureRotation: 0 | 90 | 180 | 270;
  /** Mirror the saved photo (normally false: people expect a non-mirrored print). */
  mirrorCapture: boolean;
}

/**
 * Browser webcam provider (navigator.mediaDevices.getUserMedia).
 * Intended for development, testing, and booths built around a USB/UVC camera.
 */
export class WebcamCameraProvider implements CameraProvider<Blob> {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private st: CameraStatus = status('webcam', 'disconnected');
  private listeners = new Set<(s: CameraStatus) => void>();

  constructor(private opts: WebcamOptions) {}

  onStatus(cb: (s: CameraStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.st);
    return () => this.listeners.delete(cb);
  }

  private set(state: CameraStatus['state'], extra: Partial<CameraStatus> = {}) {
    this.st = status('webcam', state, { model: this.st.model, ...extra });
    this.listeners.forEach((l) => l(this.st));
  }

  getStatus(): CameraStatus {
    return this.st;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  private pending: Promise<void> | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectFailures = 0;

  /** Opens the camera (single-flight: concurrent callers share one getUserMedia request). */
  async connect(): Promise<void> {
    this.closed = false;
    if (this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
    if (!this.pending) this.pending = this.open().finally(() => (this.pending = null));
    return this.pending;
  }

  private async open(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.set('error', { lastError: 'getUserMedia not supported' });
      throw new CameraError('CAMERA_NOT_FOUND', 'getUserMedia is not available (needs HTTPS or localhost)');
    }
    if (this.st.state !== 'connecting') this.set('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: this.opts.deviceId ? { exact: this.opts.deviceId } : undefined,
          width: { ideal: this.opts.width },
          height: { ideal: this.opts.height },
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      const name = (err as DOMException).name;
      this.set('error', { lastError: name });
      if (name === 'NotAllowedError') throw new CameraError('CAMERA_PERMISSION_DENIED', 'Camera permission denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new CameraError('CAMERA_NOT_FOUND', 'No camera found');
      if (name === 'NotReadableError') throw new CameraError('CAMERA_BUSY', 'Camera is used by another application');
      throw new CameraError('CAMERA_NOT_FOUND', (err as Error).message);
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => this.onTrackEnded(stream));
    if (this.video) this.attach(this.video);
    this.reconnectFailures = 0;
    this.set(this.video ? 'previewing' : 'ready', { model: track.label || 'Webcam' });
  }

  /**
   * A track can end on a USB hiccup, a driver reset or a cable pull. Reconnect
   * automatically; only report "error" (→ maintenance) after repeated failures.
   */
  private onTrackEnded(stream: MediaStream) {
    if (stream !== this.stream) return;
    this.stream = null;
    if (this.closed) return;
    this.set(this.reconnectFailures >= 3 ? 'error' : 'connecting', { lastError: 'Camera disconnected' });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = Math.min(10000, 300 * 2 ** this.reconnectFailures);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        this.reconnectFailures++;
        if (this.reconnectFailures >= 3) this.set('error', { lastError: 'Camera disconnected' });
        this.scheduleReconnect();
      });
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.set('disconnected');
  }

  /** Attach the live stream to a <video> element (the live-view container). */
  attach(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video && this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      video.muted = true;
      video.playsInline = true;
      void video.play().catch(() => undefined);
    }
  }

  async startPreview(): Promise<void> {
    await this.connect();
    if (this.video) this.attach(this.video);
    this.set('previewing');
  }

  async stopPreview(): Promise<void> {
    this.video?.pause();
    if (this.stream) this.set('ready');
  }

  async capture(): Promise<CapturedPhoto<Blob>> {
    const prev = this.st.state;
    let lastError: Error | null = null;
    // A frame grabbed from a stream that is just dropping is empty: verify, reconnect, retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!this.stream || !this.stream.getVideoTracks().some((t) => t.readyState === 'live')) await this.connect();
        const track = this.stream!.getVideoTracks()[0];
        if (!track || track.readyState !== 'live') throw new CameraError('CAMERA_DISCONNECTED', 'Camera disconnected');
        this.set('capturing');
        const frame = await this.grabFrame(track);
        if (frame.width < MIN_FRAME || frame.height < MIN_FRAME) {
          frame.release();
          throw new CameraError('CAMERA_CAPTURE_FAILED', `Camera returned an empty frame (${frame.width}×${frame.height})`);
        }
        const rot = this.opts.captureRotation;
        const sw = frame.width;
        const sh = frame.height;
        const canvas = document.createElement('canvas');
        canvas.width = rot % 180 === 0 ? sw : sh;
        canvas.height = rot % 180 === 0 ? sh : sw;
        const ctx = canvas.getContext('2d')!;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        if (this.opts.mirrorCapture) ctx.scale(-1, 1);
        ctx.drawImage(frame.source, -sw / 2, -sh / 2, sw, sh);
        frame.release();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((bl) => (bl ? resolve(bl) : reject(new Error('toBlob failed'))), 'image/jpeg', this.opts.jpegQuality),
        );
        this.set(prev === 'previewing' ? 'previewing' : 'ready');
        return { data: blob, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height, capturedAt: new Date(), source: 'webcam' };
      } catch (err) {
        lastError = err as Error;
        // force a fresh stream on the next attempt
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    this.set('error', { lastError: lastError?.message });
    if (lastError instanceof CameraError) throw lastError;
    throw new CameraError('CAMERA_CAPTURE_FAILED', lastError?.message ?? 'Capture failed');
  }

  /** Full-resolution frame: ImageCapture.grabFrame when available, otherwise the <video> element. */
  private async grabFrame(
    track: MediaStreamTrack,
  ): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
    const IC = (globalThis as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
    if (IC) {
      try {
        const bmp = await new IC(track).grabFrame();
        if (bmp.width >= MIN_FRAME) return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
        bmp.close();
      } catch {
        /* fall back to the video element */
      }
    }
    const v = this.video && this.video.srcObject === this.stream ? this.video : await this.offscreenVideo();
    const deadline = Date.now() + 3000;
    while (v.videoWidth < MIN_FRAME && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return { source: v, width: v.videoWidth, height: v.videoHeight, release: () => undefined };
  }

  private async offscreenVideo(): Promise<HTMLVideoElement> {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    return v;
  }

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  }
}
