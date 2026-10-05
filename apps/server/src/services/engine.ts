import type { Logger } from 'pino';
import type { Prisma, PrismaClient, Session } from '@photobooth/database';
import {
  activePhotos,
  autoPick,
  canRetake,
  defaultEdit,
  DEFAULT_TEMPLATE_ID,
  findTemplate,
  isPaid,
  PAID_STATES,
  priceFor,
  transition,
  UNPAID_STATES,
  visibleCrop,
  type EditParams,
  type PhotoTemplate,
  type SessionCommand,
  type SessionEventType,
  type SessionSnapshot,
  type SessionState,
} from '@photobooth/shared';
import { CameraError } from '@photobooth/camera';
import { PaymentProviderError, type ProviderPaymentStatus } from '@photobooth/payments';
import { AppError, appError, USER_MESSAGES } from '../errors';
import type { Env } from '../env';
import { logEvent } from '../logger';
import { randomToken, sessionCode, sha256 } from '../util/crypto';
import { KeyedMutex, retry } from '../util/mutex';
import type { EventBus } from './bus';
import type { DeviceLog } from './device-log';
import type { HardwareManager } from './hardware';
import type { MediaService } from './media';
import type { Renderer } from './renderer';
import type { SettingsService } from './settings';
import { buildSnapshot, editFromRow, FULL_INCLUDE, planOf, type FullSession, type StoredPlan } from './snapshot';
import type { GalleryService } from './gallery';
import type { LocalStorageProvider } from '@photobooth/storage';

export interface EngineDeps {
  prisma: PrismaClient;
  env: Env;
  settings: SettingsService;
  hardware: HardwareManager;
  media: MediaService;
  store: LocalStorageProvider;
  renderer: Renderer;
  gallery: GalleryService;
  bus: EventBus;
  log: Logger;
  devices: DeviceLog;
  isAcceptingSessions: () => Promise<{ ok: boolean; reason: string }>;
}

type Patch = Prisma.SessionUpdateManyMutationInput;

/**
 * SessionEngine — the single authority over session state.
 *
 * - Every state change goes through the shared FSM (`transition`) and is
 *   persisted with an optimistic version check plus a SessionEvent audit row.
 * - All commands of one session are serialized (KeyedMutex) and idempotent
 *   (x-request-id), so double taps, retries and background jobs cannot corrupt it.
 * - Hardware side effects (robot, camera, renderer, printer) are triggered here.
 */
export class SessionEngine {
  readonly mutex = new KeyedMutex();
  private readonly pipelines = new Set<string>();

  constructor(private readonly d: EngineDeps) {}

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<FullSession> {
    const s = await this.d.prisma.session.findUnique({ where: { id }, include: FULL_INCLUDE });
    if (!s) throw appError('SESSION_NOT_FOUND', 404, 'Session not found');
    return s;
  }

  async snapshot(id: string): Promise<SessionSnapshot> {
    return buildSnapshot(await this.load(id), this.d.media, (t) => this.d.gallery.url(t));
  }

  verifyToken(s: Pick<Session, 'tokenHash'>, token: string | undefined): boolean {
    return !!token && sha256(token) === s.tokenHash;
  }

  private async move(s: Session, event: SessionEventType, patch: Patch = {}, data?: Record<string, unknown>): Promise<Session> {
    const from = s.status as SessionState;
    const to = transition(from, event);
    const updated = await this.d.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({
        where: { id: s.id, version: s.version },
        data: { ...patch, status: to, version: { increment: 1 }, lastActivityAt: new Date() },
      });
      if (res.count !== 1) throw appError('CONFLICT', 409, 'Session was modified concurrently', true);
      await tx.sessionEvent.create({ data: { sessionId: s.id, event, fromStatus: from, toStatus: to, data: data ? (data as never) : undefined } });
      return tx.session.findUniqueOrThrow({ where: { id: s.id } });
    });
    logEvent(this.d.log, 'state_changed', { sessionId: s.id, from, to, trigger: event });
    this.d.bus.emitSession(s.id);
    return updated;
  }

  private async patch(s: Session, patch: Patch, event?: string, data?: Record<string, unknown>): Promise<Session> {
    const updated = await this.d.prisma.$transaction(async (tx) => {
      const res = await tx.session.updateMany({ where: { id: s.id, version: s.version }, data: { ...patch, version: { increment: 1 }, lastActivityAt: new Date() } });
      if (res.count !== 1) throw appError('CONFLICT', 409, 'Session was modified concurrently', true);
      if (event) await tx.sessionEvent.create({ data: { sessionId: s.id, event, data: data ? (data as never) : undefined } });
      return tx.session.findUniqueOrThrow({ where: { id: s.id } });
    });
    this.d.bus.emitSession(s.id);
    return updated;
  }

  private templates(): PhotoTemplate[] {
    return this.d.settings.get().templates.filter((t) => t.enabled);
  }

  private templateFor(id: string | null | undefined): PhotoTemplate {
    const list = this.templates();
    return findTemplate(list, id) ?? findTemplate(list, DEFAULT_TEMPLATE_ID) ?? list[0];
  }

  private requireState(s: Session, allowed: SessionState[]) {
    if (!allowed.includes(s.status as SessionState)) {
      throw new AppError('INVALID_TRANSITION', 409, `Command not allowed in state ${s.status}`, USER_MESSAGES.INVALID_TRANSITION);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async create(deviceId?: string): Promise<{ snapshot: SessionSnapshot; token: string }> {
    const accept = await this.d.isAcceptingSessions();
    if (!accept.ok) throw appError('MAINTENANCE', 503, `Not accepting sessions: ${accept.reason}`, true);
    const cfg = this.d.settings.get();
    const plan: StoredPlan = {
      angles: cfg.session.angles,
      shotsPerAngle: cfg.session.shotsPerAngle,
      retakeLimit: cfg.session.retakeLimit,
      countdownSeconds: cfg.session.countdownSeconds,
      readySeconds: cfg.session.readySeconds,
      angleIds: [...Array(cfg.session.angles).keys()].map((i) => cfg.angles[i % cfg.angles.length].id),
    };
    const token = randomToken(24);
    let created: Session | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      try {
        created = await this.d.prisma.session.create({
          data: {
            sessionCode: sessionCode(),
            status: 'SELECT_PRINT',
            tokenHash: sha256(token),
            deviceId: deviceId ?? null,
            plan: plan as never,
            printQuantity: 1,
            amount: priceFor(1, cfg.pricing),
            currency: cfg.pricing.currency,
            expiresAt: new Date(Date.now() + cfg.timeouts.paymentSeconds * 1000 + 120_000),
            events: { create: { event: 'START', fromStatus: 'IDLE', toStatus: 'SELECT_PRINT' } },
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err; // unique collision on code → retry
      }
    }
    if (!created) throw appError('INTERNAL', 500, 'Could not allocate a session code');
    logEvent(this.d.log, 'session_created', { sessionId: created.id, code: created.sessionCode, plan });
    return { snapshot: await this.snapshot(created.id), token };
  }

  /** Latest session that is still active (used to recover after a booth restart). */
  async findActive(): Promise<Session | null> {
    return this.d.prisma.session.findFirst({
      where: { status: { notIn: ['FINISHED', 'CANCELLED', 'EXPIRED', 'IDLE', 'RESETTING'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Issue a new booth token for a session (recovery when the booth lost its local storage). */
  async rotateToken(id: string): Promise<string> {
    const token = randomToken(24);
    await this.d.prisma.session.update({ where: { id }, data: { tokenHash: sha256(token) } });
    logEvent(this.d.log, 'session_recovered', { sessionId: id });
    return token;
  }

  // ------------------------------------------------------------------ payment

  async createPayment(id: string, quantity: number, requestId?: string): Promise<SessionSnapshot> {
    return this.mutex.run(id, async () => {
      const cfg = this.d.settings.get();
      let s = await this.load(id);
      this.requireState(s, ['SELECT_PRINT', 'WAITING_PAYMENT', 'PAYMENT_FAILED']);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.pricing.maxQuantity)
        throw appError('VALIDATION_ERROR', 400, `Quantity must be between 1 and ${cfg.pricing.maxQuantity}`);
      const amount = priceFor(quantity, cfg.pricing);
      const active = s.payments.find((p) => p.status === 'PENDING');
      if (active && active.quantity === quantity && active.expiresAt.getTime() > Date.now() + 15_000 && s.status === 'WAITING_PAYMENT') {
        return this.snapshot(id); // idempotent
      }
      // Cancel previous pending QR codes (best effort) — a late payment on them is still honoured.
      for (const p of s.payments.filter((x) => x.status === 'PENDING')) {
        try {
          const check = await this.d.hardware.payment.checkPayment(p.providerTransactionId, p.orderId);
          if (check.status === 'PAID') {
            await this.applyPaymentLocked(p.orderId, { status: 'PAID', paidAt: check.paidAt, amount: check.amount, raw: check.raw }, 'reconcile');
            return this.snapshot(id);
          }
          await this.d.hardware.payment.cancelPayment?.(p.providerTransactionId, p.orderId);
        } catch {
          /* gateway unreachable: still mark locally */
        }
        await this.d.prisma.payment.update({ where: { id: p.id }, data: { status: 'CANCELLED' } });
      }

      const orderId = `${s.sessionCode}-${s.payments.length + 1}`;
      let req;
      try {
        req = await retry(
          () =>
            this.d.hardware.payment.createPayment({
              orderId,
              amount,
              currency: cfg.pricing.currency,
              description: `Robot Photobooth ${quantity} cetak`,
              expiresInSeconds: cfg.payment.expiryMinutes * 60,
              callbackUrl: `${this.d.env.APP_URL}/api/payments/webhook/${this.d.hardware.payment.name}`,
            }),
          { retries: 2, baseMs: 400, shouldRetry: (e) => e instanceof PaymentProviderError && e.retryable },
        );
      } catch (err) {
        await this.d.devices.error('payment', 'payment_create_failed', (err as Error).message, { sessionId: id });
        if (err instanceof PaymentProviderError && err.code === 'PAYMENT_API_UNAVAILABLE')
          throw appError('PAYMENT_API_UNAVAILABLE', 503, err.message, true);
        throw appError('PAYMENT_API_UNAVAILABLE', 502, (err as Error).message, true);
      }
      await this.d.prisma.payment.create({
        data: {
          sessionId: id,
          provider: this.d.hardware.payment.name,
          providerTransactionId: req.providerTransactionId,
          orderId,
          amount,
          quantity,
          qrPayload: req.qrString,
          expiresAt: req.expiresAt,
          rawPayload: JSON.parse(JSON.stringify(req.raw ?? null)),
        },
      });
      s = await this.load(id);
      await this.move(s, 'PAYMENT_CREATED', {
        printQuantity: quantity,
        amount,
        lastCommandId: requestId ?? null,
        expiresAt: new Date(req.expiresAt.getTime() + 120_000),
      }, { orderId, amount, quantity });
      logEvent(this.d.log, 'payment_created', { sessionId: id, orderId, amount, quantity, provider: this.d.hardware.payment.name });
      return this.snapshot(id);
    });
  }

  /** Called by webhook processing / reconciliation. Serialized per session. */
  async applyPayment(orderId: string, result: { status: ProviderPaymentStatus; paidAt?: Date; amount?: number; raw: unknown }, source: string) {
    const payment = await this.d.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) {
      this.d.log.warn({ event: 'payment_unknown_order', orderId, source }, 'payment for unknown order');
      return;
    }
    await this.mutex.run(payment.sessionId, () => this.applyPaymentLocked(orderId, result, source));
  }

  private async applyPaymentLocked(orderId: string, result: { status: ProviderPaymentStatus; paidAt?: Date; amount?: number; raw: unknown }, source: string) {
    const payment = await this.d.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) return;
    const s = await this.load(payment.sessionId);
    if (payment.status === 'PAID') return; // idempotent

    if (result.status === 'PAID') {
      if (result.amount !== undefined && result.amount !== payment.amount) {
        await this.d.devices.error('payment', 'payment_amount_mismatch', `Paid ${result.amount} but expected ${payment.amount}`, { sessionId: s.id, orderId });
        return;
      }
      await this.d.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'PAID', paidAt: result.paidAt ?? new Date(), rawPayload: JSON.parse(JSON.stringify(result.raw ?? null)) },
      });
      const state = s.status as SessionState;
      if (state === 'WAITING_PAYMENT' || state === 'PAYMENT_FAILED') {
        await this.move(s, 'PAYMENT_CONFIRMED', { paidAt: new Date(), printQuantity: payment.quantity, amount: payment.amount, expiresAt: null }, { orderId, source });
        logEvent(this.d.log, 'payment_success', { sessionId: s.id, orderId, amount: payment.amount, source });
      } else if (isPaid(state)) {
        await this.d.devices.error('payment', 'payment_duplicate', `Second payment ${orderId} on an already paid session — refund required`, { sessionId: s.id, orderId, amount: payment.amount });
      } else {
        // Paid after the session was cancelled/expired: money taken, flag for refund.
        logEvent(this.d.log, 'payment_late', { sessionId: s.id, orderId, state }, 'error');
        await this.d.devices.error('payment', 'payment_after_cancel', `Payment ${orderId} settled after session ${state} — refund required`, { sessionId: s.id, orderId, amount: payment.amount });
      }
      return;
    }

    const newStatus = result.status === 'EXPIRED' ? 'EXPIRED' : result.status === 'CANCELLED' ? 'CANCELLED' : result.status === 'FAILED' ? 'FAILED' : null;
    if (!newStatus) return;
    if (payment.status === 'CANCELLED' && newStatus !== 'CANCELLED') return;
    await this.d.prisma.payment.update({ where: { id: payment.id }, data: { status: newStatus, rawPayload: JSON.parse(JSON.stringify(result.raw ?? null)) } });
    const current = s.payments.find((p) => p.status === 'PENDING');
    if (s.status === 'WAITING_PAYMENT' && current?.id === payment.id) {
      await this.move(s, newStatus === 'EXPIRED' ? 'PAYMENT_EXPIRED' : 'PAYMENT_REJECTED', {}, { orderId, source });
      logEvent(this.d.log, newStatus === 'EXPIRED' ? 'payment_expired' : 'payment_failed', { sessionId: s.id, orderId });
    }
  }

  // ------------------------------------------------------------------ commands

  async command(id: string, cmd: SessionCommand, requestId?: string): Promise<SessionSnapshot> {
    const result = await this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (requestId && s.lastCommandId === requestId) return { after: null as null | (() => void) };
      const after = await this.dispatch(s, cmd);
      if (requestId) await this.d.prisma.session.update({ where: { id }, data: { lastCommandId: requestId } }).catch(() => undefined);
      return { after };
    });
    result.after?.();
    return this.snapshot(id);
  }

  /** Executes one command. May return a callback to run after the mutex is released. */
  private async dispatch(s: FullSession, cmd: SessionCommand): Promise<(() => void) | null> {
    const plan = planOf(s);
    switch (cmd.type) {
      case 'begin': {
        await this.move(s, 'BEGIN', { startedAt: new Date(), captureAngle: 0, captureShot: null });
        void this.d.hardware.robot.home().catch((err) => this.d.devices.warn('robot', 'robot_home_failed', (err as Error).message, { sessionId: s.id }));
        return null;
      }

      case 'resume': {
        // Recovery after a booth restart in the middle of capture.
        const state = s.status as SessionState;
        if (['ROBOT_MOVING', 'POSE_GUIDANCE', 'COUNTDOWN', 'CAPTURING', 'CAPTURE_SUCCESS', 'ANGLE_COMPLETE'].includes(state)) {
          const target: SessionState = s.retakeAngle !== null ? 'RETAKE' : 'READY';
          await this.d.prisma.$transaction([
            this.d.prisma.session.update({ where: { id: s.id }, data: { status: target, version: { increment: 1 }, lastActivityAt: new Date() } }),
            this.d.prisma.sessionEvent.create({ data: { sessionId: s.id, event: 'RECOVER', fromStatus: state, toStatus: target } }),
          ]);
          this.d.bus.emitSession(s.id);
        } else if (state === 'SESSION_COMPLETE') {
          await this.move(s, 'SHOW_REVIEW');
        }
        return null;
      }

      case 'move': {
        this.requireState(s, ['READY', 'ANGLE_COMPLETE', 'RETAKE']);
        if (cmd.angle >= plan.angles) throw appError('VALIDATION_ERROR', 400, 'Angle out of range');
        if (s.retakeAngle !== null && cmd.angle !== s.retakeAngle) throw appError('VALIDATION_ERROR', 400, 'Retake angle mismatch');
        let cur = await this.move(s, 'MOVE_ROBOT', { captureAngle: cmd.angle, captureShot: null }, { angle: cmd.angle });
        const angleId = plan.angleIds[cmd.angle] ?? cmd.angle + 1;
        logEvent(this.d.log, 'robot_move_started', { sessionId: s.id, angle: cmd.angle, angleId });
        const started = Date.now();
        let degraded = false;
        try {
          await retry(() => this.d.hardware.robot.moveToAngle(angleId), {
            retries: this.d.settings.get().robot.retries,
            baseMs: 500,
            onRetry: (err, n) => this.d.log.warn({ event: 'robot_move_retry', sessionId: s.id, attempt: n + 1, err: (err as Error).message }, 'robot move retry'),
          });
          logEvent(this.d.log, 'robot_move_completed', { sessionId: s.id, angle: cmd.angle, ms: Date.now() - started });
        } catch (err) {
          degraded = true;
          logEvent(this.d.log, 'robot_move_failed', { sessionId: s.id, angle: cmd.angle, err: (err as Error).message }, 'error');
          await this.d.devices.error('robot', 'robot_move_failed', `Move to angle ${angleId} failed: ${(err as Error).message}`, { sessionId: s.id });
        }
        cur = await this.d.prisma.session.findUniqueOrThrow({ where: { id: s.id } });
        await this.move(cur, 'ROBOT_ARRIVED', {}, degraded ? { degraded: true } : undefined);
        return null;
      }

      case 'countdown': {
        this.requireState(s, ['POSE_GUIDANCE']);
        if (cmd.angle !== s.captureAngle) throw appError('VALIDATION_ERROR', 400, 'Angle mismatch');
        await this.move(s, 'START_COUNTDOWN', { captureShot: cmd.shot }, { angle: cmd.angle, shot: cmd.shot });
        return null;
      }

      case 'capture': {
        await this.captureLocked(s, cmd.angle, cmd.shot, null);
        return null;
      }

      case 'capture_failed': {
        await this.captureFailedLocked(s, cmd.angle, cmd.shot, new CameraError('CAMERA_CAPTURE_FAILED', cmd.reason));
        return null;
      }

      case 'next_shot': {
        this.requireState(s, ['CAPTURE_SUCCESS']);
        await this.move(s, 'NEXT_SHOT');
        return null;
      }

      case 'angle_done': {
        this.requireState(s, ['CAPTURE_SUCCESS']);
        let cur = await this.move(s, 'ANGLE_DONE');
        const last = s.retakeAngle !== null || (s.captureAngle ?? 0) >= plan.angles - 1;
        if (last) {
          cur = await this.move(cur, 'ALL_ANGLES_DONE', { retakeAngle: null, captureAngle: null, captureShot: null });
          await this.move(cur, 'SHOW_REVIEW');
        }
        return null;
      }

      case 'retake': {
        this.requireState(s, ['REVIEW']);
        if (!canRetake(s.retakenAngles, cmd.angle, plan.retakeLimit, plan.angles))
          throw appError('VALIDATION_ERROR', 400, 'Retake not allowed for this angle (limit reached or already retaken)');
        await this.move(s, 'START_RETAKE', { retakeAngle: cmd.angle, retakenAngles: { push: cmd.angle }, captureAngle: cmd.angle, captureShot: null }, { angle: cmd.angle });
        return null;
      }

      case 'select_angle': {
        this.requireState(s, ['REVIEW']);
        const angleShots = s.photos.filter((p) => p.angle === cmd.angle);
        const ids = new Set(cmd.photoIds);
        if (cmd.photoIds.some((pid) => !angleShots.find((p) => p.id === pid))) throw appError('VALIDATION_ERROR', 400, 'Photo does not belong to this angle');
        if (ids.size !== Math.min(plan.shotsPerAngle, angleShots.length)) throw appError('VALIDATION_ERROR', 400, `Select exactly ${plan.shotsPerAngle} photos`);
        await this.d.prisma.$transaction(
          angleShots.map((p) => this.d.prisma.photo.update({ where: { id: p.id }, data: { selected: ids.has(p.id), superseded: !ids.has(p.id) } })),
        );
        // Frame picks referencing a deselected photo are dropped.
        await this.d.prisma.edit.deleteMany({ where: { sessionId: s.id, photoId: { in: angleShots.filter((p) => !ids.has(p.id)).map((p) => p.id) } } });
        await this.patch(s, {}, 'SELECT_ANGLE', { angle: cmd.angle, photoIds: cmd.photoIds });
        return null;
      }

      case 'choose_frame': {
        this.requireState(s, ['REVIEW']);
        await this.move(s, 'CHOOSE_FRAME');
        return null;
      }

      case 'set_template': {
        this.requireState(s, ['FRAME_SELECTION']);
        const t = findTemplate(this.templates(), cmd.templateId);
        if (!t) throw appError('VALIDATION_ERROR', 400, 'Unknown template');
        if (t.id !== s.selectedTemplate) await this.d.prisma.edit.deleteMany({ where: { sessionId: s.id } });
        await this.patch(s, { selectedTemplate: t.id }, 'SET_TEMPLATE', { templateId: t.id });
        return null;
      }

      case 'frame': {
        this.requireState(s, ['FRAME_SELECTION']);
        const t = findTemplate(this.templates(), cmd.templateId);
        if (!t) throw appError('VALIDATION_ERROR', 400, 'Unknown template');
        if (t.photoCount > s.photos.filter((p) => p.selected).length) throw appError('VALIDATION_ERROR', 400, 'Not enough photos for this frame');
        if (t.id !== s.selectedTemplate) await this.d.prisma.edit.deleteMany({ where: { sessionId: s.id } });
        await this.move(s, 'FRAME_CHOSEN', { selectedTemplate: t.id }, { templateId: t.id });
        return null;
      }

      case 'photos': {
        this.requireState(s, ['PHOTO_SELECTION']);
        const t = this.templateFor(s.selectedTemplate);
        await this.assignSlots(s, t, cmd.photoIds);
        await this.move(s, 'PHOTOS_CHOSEN', {}, { photoIds: cmd.photoIds });
        return null;
      }

      case 'edits':
      case 'edit_done': {
        this.requireState(s, ['EDITING']);
        await this.saveEdits(s, cmd.slots);
        if (cmd.type === 'edit_done') {
          await this.move(s, 'EDIT_DONE');
          return () => void this.prerender(s.id);
        }
        await this.d.prisma.session.update({ where: { id: s.id }, data: { lastActivityAt: new Date() } });
        return null;
      }

      case 'back': {
        this.requireState(s, ['FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING', 'FINAL_PREVIEW']);
        await this.move(s, 'BACK');
        return null;
      }

      case 'prerender': {
        return () => void this.prerender(s.id);
      }

      case 'confirm': {
        this.requireState(s, ['FINAL_PREVIEW']);
        await this.move(s, 'CONFIRM');
        return () => void this.runOutputPipeline(s.id);
      }

      case 'auto_complete': {
        await this.autoCompleteLocked(s, 'booth_timeout');
        return () => void this.runOutputPipeline(s.id);
      }

      case 'skip_session': {
        await this.skipSessionLocked(s);
        return () => void this.runOutputPipeline(s.id);
      }

      case 'finish': {
        this.requireState(s, ['QR_READY']);
        await this.move(s, 'FINISH', { finishedAt: new Date() });
        logEvent(this.d.log, 'session_finished', { sessionId: s.id, durationMs: Date.now() - s.createdAt.getTime() });
        return null;
      }

      case 'cancel': {
        this.requireState(s, [...UNPAID_STATES] as SessionState[]);
        // Make sure the customer did not pay at the very last second.
        for (const p of s.payments.filter((x) => x.status === 'PENDING')) {
          try {
            const check = await this.d.hardware.payment.checkPayment(p.providerTransactionId, p.orderId);
            if (check.status === 'PAID') {
              await this.applyPaymentLocked(p.orderId, { status: 'PAID', paidAt: check.paidAt, amount: check.amount, raw: check.raw }, 'cancel_check');
              return null;
            }
            await this.d.hardware.payment.cancelPayment?.(p.providerTransactionId, p.orderId);
          } catch {
            /* offline: cancel locally */
          }
          await this.d.prisma.payment.update({ where: { id: p.id }, data: { status: 'CANCELLED' } });
        }
        await this.move(s, 'CANCEL', { finishedAt: new Date() });
        logEvent(this.d.log, 'session_cancelled', { sessionId: s.id });
        return null;
      }

      case 'retry_payment': {
        this.requireState(s, ['PAYMENT_FAILED']);
        await this.move(s, 'RETRY_PAYMENT');
        return null;
      }
    }
  }

  // ------------------------------------------------------------------ capture

  /** Capture with the server camera (`data === null`) or store an uploaded browser frame. */
  async capture(id: string, angle: number, shot: number, data: Buffer | null, requestId?: string): Promise<SessionSnapshot> {
    await this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (requestId && s.lastCommandId === requestId) return;
      await this.captureLocked(s, angle, shot, data);
      if (requestId) await this.d.prisma.session.update({ where: { id }, data: { lastCommandId: requestId } });
    });
    return this.snapshot(id);
  }

  private async captureLocked(s0: FullSession, angle: number, shot: number, data: Buffer | null) {
    let s: Session = s0;
    const plan = planOf(s);
    if (s.status === 'POSE_GUIDANCE') s = await this.move(s, 'START_COUNTDOWN', { captureShot: shot });
    this.requireState(s, ['COUNTDOWN']);
    if (angle !== s.captureAngle) throw appError('VALIDATION_ERROR', 400, 'Angle mismatch');
    if (shot < 0 || shot >= plan.shotsPerAngle) throw appError('VALIDATION_ERROR', 400, 'Shot out of range');
    const isRetake = s.retakeAngle !== null;
    const shotNumber = isRetake ? plan.shotsPerAngle + shot : shot;

    const existing = s0.photos.find((p) => p.angle === angle && p.shotNumber === shotNumber);
    s = await this.move(s, 'CAPTURE', { captureShot: shot }, { angle, shot });
    logEvent(this.d.log, 'capture_started', { sessionId: s.id, angle, shot, retake: isRetake });
    if (existing) {
      await this.move(s, 'CAPTURE_OK', { captureFailures: 0 }, { angle, shot, duplicate: true });
      return;
    }
    try {
      let bytes = data;
      let source = 'webcam';
      if (!bytes) {
        const cam = this.d.hardware.camera;
        if (!cam) throw new CameraError('CAMERA_NOT_FOUND', 'No server camera configured (driver is webcam: upload expected)');
        const photo = await cam.capture({ sessionId: s.id, sessionCode: s.sessionCode, angle, shot: shotNumber });
        bytes = photo.data;
        source = photo.source;
      }
      const ingested = await this.d.media.ingestPhoto(s.id, angle, shotNumber, bytes);
      await this.d.prisma.photo.create({
        data: {
          sessionId: s.id,
          angle,
          shotNumber,
          originalPath: ingested.originalKey,
          previewPath: ingested.previewKey,
          thumbnailPath: ingested.thumbKey,
          width: ingested.width,
          height: ingested.height,
          bytes: ingested.bytes,
          source,
          selected: !isRetake,
          retaken: isRetake,
        },
      });
      await this.move(s, 'CAPTURE_OK', { captureFailures: 0 }, { angle, shot, shotNumber });
      logEvent(this.d.log, 'capture_success', { sessionId: s.id, angle, shot: shotNumber, bytes: ingested.bytes, source });
    } catch (err) {
      await this.captureFailedLocked(s, angle, shot, err as Error);
      throw err instanceof AppError
        ? err
        : appError(err instanceof CameraError && err.code === 'CAMERA_DISCONNECTED' ? 'CAMERA_DISCONNECTED' : 'CAMERA_CAPTURE_FAILED', 502, (err as Error).message, true);
    }
  }

  private async captureFailedLocked(s0: Session, angle: number, shot: number, err: Error) {
    let s = await this.d.prisma.session.findUniqueOrThrow({ where: { id: s0.id } });
    if (s.status === 'POSE_GUIDANCE') s = await this.move(s, 'START_COUNTDOWN', { captureShot: shot });
    if (s.status === 'COUNTDOWN') s = await this.move(s, 'CAPTURE', {}, { angle, shot });
    if (s.status !== 'CAPTURING') return;
    const failures = s.captureFailures + 1;
    logEvent(this.d.log, 'capture_failed', { sessionId: s.id, angle, shot, failures, err: err.message }, 'error');
    await this.d.devices.error('camera', 'capture_failed', err.message, { sessionId: s.id, angle, shot, failures });
    s = await this.move(s, 'CAPTURE_FAILED', { captureFailures: failures }, { angle, shot, error: err.message });
    const max = this.d.settings.get().session.maxCaptureRetries;
    if (failures > max) {
      await this.move(s, 'FAIL', { errorCode: 'CAMERA_CAPTURE_FAILED', errorMessage: err.message.slice(0, 500) }, { reason: 'capture_retries_exhausted' });
    }
  }

  // ------------------------------------------------------------------ skip session (testing)
  // Generates placeholder photos so the session can proceed to rendering without real captures.
  async skipSessionLocked(s0: FullSession) {
    const s = await this.load(s0.id);
    const state = s.status as SessionState;
    if (!['READY', 'ROBOT_MOVING', 'POSE_GUIDANCE', 'COUNTDOWN', 'CAPTURING', 'CAPTURE_SUCCESS', 'ANGLE_COMPLETE', 'SESSION_COMPLETE', 'REVIEW', 'RETAKE'].includes(state)) {
      throw new AppError('INVALID_TRANSITION', 409, `Cannot skip session from ${state}`, USER_MESSAGES.INVALID_TRANSITION);
    }
    const plan = planOf(s);
    const hasPhotos = s.photos.length > 0;
    if (!hasPhotos) {
      // Generate placeholder photos for each angle
      const placeholderBuf = Buffer.alloc(1024, 0);
      for (let a = 0; a < plan.angles; a++) {
        for (let sh = 0; sh < plan.shotsPerAngle; sh++) {
          const key = `sessions/${s.id}/original/a${String(a + 1).padStart(2, '0')}_s${String(sh + 1).padStart(2, '0')}.jpg`;
          try {
            await this.d.store.put(key, placeholderBuf);
            const photo = await this.d.prisma.photo.create({
              data: {
                sessionId: s.id,
                angle: a,
                shotNumber: sh,
                selected: sh === 0,
                superseded: sh > 0,
                retaken: false,
                originalPath: key,
                processedPath: key,
                previewPath: key,
                thumbnailPath: key,
                width: 1920,
                height: 1080,
              },
            });
            if (sh === 0) {
              await this.d.prisma.edit.create({
                data: { sessionId: s.id, photoId: photo.id, slotIndex: a, x: 0, y: 0, zoom: 1, rotation: 0, flipHorizontal: false, brightness: 1, filter: 'original', crop: { x: 0, y: 0, w: 100, h: 100 } },
              });
            }
          } catch {
            /* skip on error */
          }
        }
      }
    }
    // Fast-forward to REVIEW → auto-complete → rendering
    if (!['REVIEW', 'SESSION_COMPLETE'].includes(s.status as SessionState)) {
      await this.move(s, 'ALL_ANGLES_DONE');
      await this.move(await this.load(s.id), 'SHOW_REVIEW');
    }
    await this.autoCompleteLocked(await this.load(s.id), 'booth_skip');
  }

  // ------------------------------------------------------------------ selection & edits

  private async assignSlots(s: FullSession, t: PhotoTemplate, photoIds: string[]) {
    if (photoIds.length !== t.photoCount) throw appError('VALIDATION_ERROR', 400, `Pick exactly ${t.photoCount} photos`);
    if (new Set(photoIds).size !== photoIds.length) throw appError('VALIDATION_ERROR', 400, 'Duplicate photo');
    const active = new Set(activePhotos(s.photos.map((p) => ({ ...p, shot: p.shotNumber }))).map((p) => p.id));
    if (photoIds.some((pid) => !active.has(pid))) throw appError('VALIDATION_ERROR', 400, 'Photo is not part of the session selection');
    const existing = new Map(s.edits.map((e) => [e.slotIndex, e]));
    await this.d.prisma.$transaction([
      this.d.prisma.edit.deleteMany({ where: { sessionId: s.id, slotIndex: { gte: t.photoCount } } }),
      ...photoIds.map((photoId, slotIndex) => {
        const prev = existing.get(slotIndex);
        const keep = prev && prev.photoId === photoId;
        const e = keep ? editFromRow(prev) : defaultEdit();
        return this.d.prisma.edit.upsert({
          where: { sessionId_slotIndex: { sessionId: s.id, slotIndex } },
          create: { sessionId: s.id, slotIndex, photoId, ...e, crop: visibleCrop(e) as never },
          update: { photoId, ...e, crop: visibleCrop(e) as never },
        });
      }),
    ]);
  }

  private async saveEdits(s: FullSession, slots: { slotIndex: number; edit: EditParams }[]) {
    const known = new Set(s.edits.map((e) => e.slotIndex));
    const ops = slots
      .filter((x) => known.has(x.slotIndex))
      .map((x) =>
        this.d.prisma.edit.update({
          where: { sessionId_slotIndex: { sessionId: s.id, slotIndex: x.slotIndex } },
          data: { ...x.edit, crop: visibleCrop(x.edit) as never },
        }),
      );
    if (ops.length) await this.d.prisma.$transaction(ops);
  }

  /** Fill sensible defaults so a paid customer always gets prints, even when idle. */
  private async autoCompleteLocked(s: FullSession, reason: string) {
    const state = s.status as SessionState;
    if (!['REVIEW', 'FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING', 'FINAL_PREVIEW'].includes(state)) {
      throw new AppError('INVALID_TRANSITION', 409, `Cannot auto-complete from ${state}`, USER_MESSAGES.INVALID_TRANSITION);
    }
    const active = activePhotos(s.photos.map((p) => ({ ...p, shot: p.shotNumber }))).map((p) => p.id);
    let t = this.templateFor(s.selectedTemplate);
    if (t.photoCount > active.length) {
      // Fewer photos than the frame needs (small capture plans): use the largest frame that fits.
      const fits = this.templates()
        .filter((x) => x.photoCount <= active.length)
        .sort((a, b) => b.photoCount - a.photoCount);
      if (!fits.length) throw appError('VALIDATION_ERROR', 400, 'Not enough photos for any frame');
      t = fits[0];
    }
    const slotsOk = s.edits.length === t.photoCount && s.selectedTemplate === t.id;
    if (!slotsOk) {
      await this.d.prisma.edit.deleteMany({ where: { sessionId: s.id } });
      await this.assignSlots({ ...s, edits: [] }, t, autoPick(active, t.photoCount));
    }
    await this.move(s, 'AUTO_COMPLETE', { selectedTemplate: t.id, autoCompleted: true }, { reason });
    logEvent(this.d.log, 'session_auto_completed', { sessionId: s.id, reason, from: state });
  }

  /** Server-side safety net (booth gone): auto-complete abandoned paid sessions. */
  async autoComplete(id: string, reason: string) {
    await this.mutex.run(id, async () => this.autoCompleteLocked(await this.load(id), reason));
    void this.runOutputPipeline(id);
  }

  // ------------------------------------------------------------------ output pipeline

  private async renderInput(s: FullSession) {
    const t = this.templateFor(s.selectedTemplate);
    const photos = new Map(s.photos.map((p) => [p.id, p]));
    const slots = s.edits
      .filter((e) => e.slotIndex < t.photoCount && photos.has(e.photoId))
      .map((e) => ({ slotIndex: e.slotIndex, originalKey: photos.get(e.photoId)!.originalPath, edit: editFromRow(e) }));
    const cfg = this.d.settings.get();
    return { sessionId: s.id, template: t, slots, printer: cfg.printer, label: t.label || cfg.branding.label };
  }

  /** Warm the render cache while the customer looks at the final preview. */
  async prerender(id: string) {
    try {
      const s = await this.load(id);
      if (!['FINAL_PREVIEW', 'EDITING'].includes(s.status)) return;
      const out = await this.d.renderer.render(await this.renderInput(s), { hash: s.renderHash, compositeKey: s.compositePath, printKey: s.printFilePath });
      await this.d.prisma.session.update({ where: { id }, data: { renderHash: out.hash, compositePath: out.compositeKey, printFilePath: out.printKey } });
    } catch (err) {
      this.d.log.warn({ event: 'prerender_failed', sessionId: id, err: (err as Error).message }, 'prerender failed');
    }
  }

  /** RENDERING → (composite + print page) → PRINTING with a persistent print job. */
  async runOutputPipeline(id: string) {
    if (this.pipelines.has(id)) return;
    this.pipelines.add(id);
    try {
      await this.mutex.run(id, async () => {
        const s = await this.load(id);
        if (s.status !== 'RENDERING') return;
        const input = await this.renderInput(s);
        logEvent(this.d.log, 'render_started', { sessionId: id, template: input.template.id, slots: input.slots.length });
        const started = Date.now();
        let out;
        try {
          out = await retry(() => this.d.renderer.render(input, { hash: s.renderHash, compositeKey: s.compositePath, printKey: s.printFilePath }), { retries: 1, baseMs: 500 });
        } catch (err) {
          logEvent(this.d.log, 'render_failed', { sessionId: id, err: (err as Error).message }, 'error');
          await this.d.devices.error('system', 'render_failed', (err as Error).message, { sessionId: id });
          await this.move(s, 'RENDER_FAILED', { errorCode: 'RENDER_FAILED', errorMessage: (err as Error).message.slice(0, 500) });
          return;
        }
        logEvent(this.d.log, 'render_success', { sessionId: id, ms: Date.now() - started, reused: out.reused, width: out.width, height: out.height });
        const cfg = this.d.settings.get();
        const job = await this.d.prisma.printJob.create({
          data: {
            sessionId: id,
            printer: cfg.printer.name || cfg.printer.driver,
            copies: s.printQuantity,
            filePath: out.printKey,
            maxAttempts: cfg.printer.maxAttempts,
            status: 'QUEUED',
          },
        });
        logEvent(this.d.log, 'print_queued', { sessionId: id, jobId: job.id, copies: job.copies });
        await this.move(s, 'RENDER_DONE', { renderHash: out.hash, compositePath: out.compositeKey, printFilePath: out.printKey }, { jobId: job.id });
      });
    } finally {
      this.pipelines.delete(id);
    }
  }

  /** Called by the print queue for the session's own (non-reprint) job. */
  async onPrintOutcome(sessionId: string, ok: boolean, errorCode?: string | null) {
    await this.mutex.run(sessionId, async () => {
      const s = await this.load(sessionId);
      if (s.status !== 'PRINTING') return;
      await this.move(s, ok ? 'PRINT_DONE' : 'PRINT_FAILED', ok ? {} : { errorCode: errorCode ?? 'PRINT_FAILED' });
    });
    await this.generateGallery(sessionId);
  }

  async generateGallery(sessionId: string) {
    await this.mutex.run(sessionId, async () => {
      let s: Session = await this.load(sessionId);
      if (s.status !== 'PRINT_SUCCESS' && s.status !== 'PRINT_FAILED') return;
      s = await this.move(s, 'GENERATE_GALLERY');
      try {
        const g = await this.d.gallery.create(s);
        s = await this.d.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
        await this.move(s, 'GALLERY_READY', {}, { expiresAt: g.expiresAt.toISOString() });
        logEvent(this.d.log, 'gallery_created', { sessionId, expiresAt: g.expiresAt.toISOString() });
      } catch (err) {
        await this.d.devices.error('system', 'gallery_failed', (err as Error).message, { sessionId });
        s = await this.d.prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
        await this.move(s, 'GALLERY_FAILED', { errorCode: 'GALLERY_FAILED', errorMessage: (err as Error).message.slice(0, 500) });
      }
    });
  }

  // ------------------------------------------------------------------ admin operations

  async adminCancel(id: string, by: string) {
    await this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (['FINISHED', 'CANCELLED', 'EXPIRED'].includes(s.status)) return;
      for (const p of s.payments.filter((x) => x.status === 'PENDING')) {
        await this.d.hardware.payment.cancelPayment?.(p.providerTransactionId, p.orderId).catch(() => undefined);
        await this.d.prisma.payment.update({ where: { id: p.id }, data: { status: 'CANCELLED' } });
      }
      await this.d.prisma.$transaction([
        this.d.prisma.session.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date(), version: { increment: 1 } } }),
        this.d.prisma.sessionEvent.create({ data: { sessionId: id, event: 'ADMIN_CANCEL', fromStatus: s.status, toStatus: 'CANCELLED', data: { by } } }),
      ]);
      this.d.bus.emitSession(id);
      logEvent(this.d.log, 'session_cancelled', { sessionId: id, by, paid: PAID_STATES.has(s.status as SessionState) });
    });
  }

  /** Move an ERROR session back to a safe state chosen by the admin. */
  async adminResume(id: string, target: 'REVIEW' | 'READY' | 'FINAL_PREVIEW' | 'QR_READY', by: string) {
    await this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (s.status !== 'ERROR') throw appError('INVALID_TRANSITION', 409, 'Only sessions in ERROR can be resumed');
      await this.d.prisma.$transaction([
        this.d.prisma.session.update({ where: { id }, data: { status: target, errorCode: null, errorMessage: null, captureFailures: 0, version: { increment: 1 }, lastActivityAt: new Date() } }),
        this.d.prisma.sessionEvent.create({ data: { sessionId: id, event: 'ADMIN_RESUME', fromStatus: 'ERROR', toStatus: target, data: { by } } }),
      ]);
      this.d.bus.emitSession(id);
    });
  }

  async adminRerender(id: string): Promise<{ compositeKey: string; printKey: string }> {
    return this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (!s.edits.length) throw appError('VALIDATION_ERROR', 400, 'Session has no frame selection');
      const out = await this.d.renderer.render(await this.renderInput(s));
      await this.d.prisma.session.update({ where: { id }, data: { renderHash: out.hash, compositePath: out.compositeKey, printFilePath: out.printKey } });
      return { compositeKey: out.compositeKey, printKey: out.printKey };
    });
  }

  async adminReprint(id: string, copies: number, by: string) {
    const s = await this.load(id);
    let printKey = s.printFilePath;
    if (!printKey || !(await this.d.store.exists(printKey))) printKey = (await this.adminRerender(id)).printKey;
    const cfg = this.d.settings.get();
    const job = await this.d.prisma.printJob.create({
      data: { sessionId: id, printer: cfg.printer.name || cfg.printer.driver, copies, filePath: printKey, maxAttempts: cfg.printer.maxAttempts, isReprint: true, requestedBy: by },
    });
    await this.d.prisma.sessionEvent.create({ data: { sessionId: id, event: 'ADMIN_REPRINT', data: { by, copies, jobId: job.id } } });
    logEvent(this.d.log, 'print_queued', { sessionId: id, jobId: job.id, copies, reprint: true, by });
    return job;
  }

  async adminRegenerateGallery(id: string, by: string) {
    return this.mutex.run(id, async () => {
      const s = await this.load(id);
      if (!s.compositePath && !s.photos.length) throw appError('VALIDATION_ERROR', 400, 'Session has no photos');
      const g = await this.d.gallery.create(s, { rotate: true });
      await this.d.prisma.sessionEvent.create({ data: { sessionId: id, event: 'ADMIN_REGENERATE_GALLERY', data: { by } } });
      this.d.bus.emitSession(id);
      return g;
    });
  }
}
