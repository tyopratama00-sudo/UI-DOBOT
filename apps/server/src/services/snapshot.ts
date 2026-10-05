import type { Edit, Payment, Photo, PrintJob, Session } from '@photobooth/database';
import type { EditParams, FilterId, PrintDTO, SessionPlan, SessionSnapshot, SessionState } from '@photobooth/shared';
import { USER_MESSAGES } from '../errors';
import type { MediaService } from './media';

export type FullSession = Session & {
  payments: Payment[];
  photos: Photo[];
  edits: Edit[];
  printJobs: PrintJob[];
};

export const FULL_INCLUDE = {
  payments: { orderBy: { createdAt: 'desc' as const } },
  photos: { orderBy: [{ angle: 'asc' as const }, { shotNumber: 'asc' as const }] },
  edits: { orderBy: { slotIndex: 'asc' as const } },
  printJobs: { orderBy: { createdAt: 'desc' as const } },
};

export interface StoredPlan extends SessionPlan {
  angleIds: number[];
}

export function planOf(s: Session): StoredPlan {
  return s.plan as unknown as StoredPlan;
}

export function editFromRow(e: Edit): EditParams {
  return {
    x: e.x,
    y: e.y,
    zoom: e.zoom,
    rotation: e.rotation,
    flipHorizontal: e.flipHorizontal,
    brightness: e.brightness,
    filter: (e.filter as FilterId) ?? 'original',
  };
}

export function printDto(job: PrintJob | undefined): PrintDTO | null {
  if (!job) return null;
  const code = job.errorCode ?? (job.status === 'FAILED' ? 'PRINT_FAILED' : null);
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    copies: job.copies,
    error: job.error,
    userMessage: code ? (USER_MESSAGES[code] ?? USER_MESSAGES.PRINT_FAILED) : null,
  };
}

export function buildSnapshot(s: FullSession, media: MediaService, galleryUrl: (token: string) => string): SessionSnapshot {
  const plan = planOf(s);
  const payment = s.payments.find((p) => p.status !== 'CANCELLED') ?? s.payments[0] ?? null;
  const sessionJob = s.printJobs.find((j) => !j.isReprint);
  return {
    id: s.id,
    code: s.sessionCode,
    status: s.status as SessionState,
    quantity: s.printQuantity,
    amount: s.amount,
    templateId: s.selectedTemplate,
    createdAt: s.createdAt.toISOString(),
    paidAt: s.paidAt?.toISOString() ?? null,
    expiresAt: s.expiresAt?.toISOString() ?? null,
    plan: {
      angles: plan.angles,
      shotsPerAngle: plan.shotsPerAngle,
      retakeLimit: plan.retakeLimit,
      countdownSeconds: plan.countdownSeconds,
      readySeconds: plan.readySeconds,
    },
    payment: payment
      ? {
          id: payment.id,
          provider: payment.provider,
          status: payment.status,
          amount: payment.amount,
          quantity: payment.quantity,
          qrString: payment.qrPayload,
          expiresAt: payment.expiresAt.toISOString(),
          paidAt: payment.paidAt?.toISOString() ?? null,
        }
      : null,
    photos: s.photos.map((p) => ({
      id: p.id,
      angle: p.angle,
      shot: p.shotNumber,
      selected: p.selected,
      retaken: p.retaken,
      superseded: p.superseded,
      width: p.width,
      height: p.height,
      thumbUrl: media.url(p.thumbnailPath ?? p.originalPath),
      previewUrl: media.url(p.previewPath ?? p.originalPath),
      createdAt: p.createdAt.toISOString(),
    })),
    slots: s.edits.map((e) => ({ slotIndex: e.slotIndex, photoId: e.photoId, edit: editFromRow(e) })),
    retakenAngles: s.retakenAngles,
    capture: { angle: s.captureAngle, shot: s.captureShot, retakeAngle: s.retakeAngle },
    print: printDto(sessionJob),
    gallery:
      s.galleryToken && s.galleryExpiresAt ? { url: galleryUrl(s.galleryToken), expiresAt: s.galleryExpiresAt.toISOString() } : null,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
  };
}
