import { z } from 'zod';
import type { SessionState } from './fsm';
import type { EditParams } from './edit';
import { editParamsSchema } from './edit';
import type { PhotoTemplate } from './templates';
import type { Settings } from './config';

export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
export type PrintJobStatus = 'QUEUED' | 'RENDERING' | 'PRINTING' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'CANCELLED';

export interface PaymentDTO {
  id: string;
  provider: string;
  status: PaymentStatus;
  amount: number;
  quantity: number;
  /** Raw QR payload (EMVCo QRIS string or URL) to encode on screen. */
  qrString: string;
  expiresAt: string;
  paidAt: string | null;
}

export interface PhotoDTO {
  id: string;
  angle: number;
  shot: number;
  selected: boolean;
  retaken: boolean;
  superseded: boolean;
  width: number | null;
  height: number | null;
  thumbUrl: string;
  previewUrl: string;
  createdAt: string;
}

export interface SlotDTO {
  slotIndex: number;
  photoId: string;
  edit: EditParams;
}

export interface PrintDTO {
  jobId: string;
  status: PrintJobStatus;
  progress: number;
  copies: number;
  error: string | null;
  userMessage: string | null;
}

export interface GalleryDTO {
  url: string;
  expiresAt: string;
}

export interface SessionPlan {
  angles: number;
  shotsPerAngle: number;
  retakeLimit: number;
  countdownSeconds: number;
  readySeconds: number;
}

export interface SessionSnapshot {
  id: string;
  code: string;
  status: SessionState;
  quantity: number;
  amount: number;
  templateId: string | null;
  createdAt: string;
  paidAt: string | null;
  expiresAt: string | null;
  plan: SessionPlan;
  payment: PaymentDTO | null;
  photos: PhotoDTO[];
  slots: SlotDTO[];
  retakenAngles: number[];
  /** Capture cursor (0-based angle / shot) while in the capture phase. */
  capture: { angle: number | null; shot: number | null; retakeAngle: number | null };
  print: PrintDTO | null;
  gallery: GalleryDTO | null;
  version: number;
  updatedAt: string;
}

/** Response of session creation: includes the per-session secret used for subsequent calls. */
export interface SessionCreated {
  session: SessionSnapshot;
  token: string;
}

export type CameraMode = 'browser' | 'server' | 'mock';

export interface BoothConfig {
  pricing: Settings['pricing'];
  session: Settings['session'];
  timeouts: Settings['timeouts'];
  camera: Omit<Settings['camera'], 'digicamUrl' | 'gphoto2Bin' | 'captureCommand' | 'previewUrl'> & {
    mode: CameraMode;
    liveViewUrl: string | null;
  };
  templates: PhotoTemplate[];
  angles: { id: number; name: string }[];
  branding: Settings['branding'];
  timingScale: number;
  devTools: boolean;
  environment: string;
}

export interface HealthReport {
  ok: boolean;
  acceptingSessions: boolean;
  checkedAt: string;
  components: {
    server: ComponentHealth;
    database: ComponentHealth;
    storage: ComponentHealth;
    camera: ComponentHealth;
    robot: ComponentHealth;
    printer: ComponentHealth;
    payment: ComponentHealth;
    internet: ComponentHealth;
  };
}

export interface ComponentHealth {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  critical: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

/** Commands the booth sends to POST /api/sessions/:id/commands */
export const sessionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin') }),
  z.object({ type: z.literal('move'), angle: z.number().int().min(0).max(19) }),
  z.object({ type: z.literal('countdown'), angle: z.number().int().min(0).max(19), shot: z.number().int().min(0).max(9) }),
  z.object({ type: z.literal('capture'), angle: z.number().int().min(0).max(19), shot: z.number().int().min(0).max(9) }),
  z.object({
    type: z.literal('capture_failed'),
    angle: z.number().int().min(0).max(19),
    shot: z.number().int().min(0).max(9),
    reason: z.string().max(300),
  }),
  /** Re-synchronise the capture phase after a booth restart. */
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('next_shot') }),
  z.object({ type: z.literal('angle_done') }),
  z.object({ type: z.literal('retake'), angle: z.number().int().min(0).max(19) }),
  z.object({ type: z.literal('select_angle'), angle: z.number().int().min(0).max(19), photoIds: z.array(z.string().max(40)).min(1).max(10) }),
  z.object({ type: z.literal('choose_frame') }),
  z.object({ type: z.literal('set_template'), templateId: z.string().max(40) }),
  z.object({ type: z.literal('frame'), templateId: z.string().max(40) }),
  z.object({ type: z.literal('photos'), photoIds: z.array(z.string().max(40)).min(1).max(12) }),
  z.object({
    type: z.literal('edits'),
    slots: z.array(z.object({ slotIndex: z.number().int().min(0).max(11), edit: editParamsSchema })).max(12),
  }),
  z.object({
    type: z.literal('edit_done'),
    slots: z.array(z.object({ slotIndex: z.number().int().min(0).max(11), edit: editParamsSchema })).max(12),
  }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('prerender') }),
  z.object({ type: z.literal('confirm') }),
  z.object({ type: z.literal('auto_complete') }),
  z.object({ type: z.literal('finish') }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('retry_payment') }),
]);
export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Friendly Indonesian text safe to show on the booth. */
    userMessage?: string;
    retryable?: boolean;
  };
}
