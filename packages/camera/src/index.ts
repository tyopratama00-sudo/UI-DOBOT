/**
 * Camera abstraction. The application never talks to a webcam or DSLR
 * directly; it talks to a CameraProvider. Browser providers (webcam) live in
 * `@photobooth/camera/browser`, server-side drivers (mock, gPhoto2,
 * digiCamControl, vendor command line) in `@photobooth/camera/node`.
 */

export type CameraState = 'disconnected' | 'connecting' | 'ready' | 'previewing' | 'capturing' | 'error';

export interface CameraStatus {
  state: CameraState;
  driver: string;
  model?: string;
  message?: string;
  lastError?: string;
  updatedAt: string;
}

export interface CapturedPhoto<TData = unknown> {
  data: TData;
  mimeType: string;
  width?: number;
  height?: number;
  capturedAt: Date;
  source: string;
}

export interface CameraProvider<TData = unknown> {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  capture(): Promise<CapturedPhoto<TData>>;
  getStatus(): CameraStatus;
}

export class CameraError extends Error {
  constructor(
    readonly code:
      | 'CAMERA_NOT_FOUND'
      | 'CAMERA_PERMISSION_DENIED'
      | 'CAMERA_DISCONNECTED'
      | 'CAMERA_CAPTURE_FAILED'
      | 'CAMERA_BUSY'
      | 'CAMERA_TIMEOUT'
      | 'CAMERA_SIMULATED_FAILURE',
    message: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export function status(driver: string, state: CameraState, extra: Partial<CameraStatus> = {}): CameraStatus {
  return { driver, state, updatedAt: new Date().toISOString(), ...extra };
}
