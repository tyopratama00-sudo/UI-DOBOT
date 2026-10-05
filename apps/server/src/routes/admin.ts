import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SETTINGS_SECTIONS, type SettingsSection } from '@photobooth/shared';
import { SystemPrinterProvider } from '@photobooth/printer';
import type { AppContext } from '../context';
import { appError } from '../errors';
import { hashPassword, jwtSign, jwtVerify, verifyPassword, type JwtPayload } from '../util/crypto';
import { buildSnapshot, FULL_INCLUDE } from '../services/snapshot';
import { qrSvg, simulatePaymentWebhook } from './public';

const COOKIE = 'pb_admin';
const TTL = 12 * 3600;

declare module 'fastify' {
  interface FastifyRequest {
    admin?: JwtPayload;
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { prisma, engine, env } = ctx;

  const requireAdmin = async (req: FastifyRequest) => {
    const token = req.cookies?.[COOKIE] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
    const payload = token ? jwtVerify(token, env.secrets.jwt) : null;
    if (!payload) throw appError('UNAUTHORIZED', 401, 'Admin login required');
    req.admin = payload;
  };

  // ---------------------------------------------------------------- auth
  app.post('/api/admin/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { username, password } = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
    const user = await prisma.adminUser.findUnique({ where: { username } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
    if (!user || !ok) {
      await ctx.devices.warn('system', 'admin_login_failed', `Failed admin login for "${username}"`, { ip: req.ip });
      throw appError('UNAUTHORIZED', 401, 'Invalid username or password');
    }
    await prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = jwtSign({ sub: user.id, name: user.username }, env.secrets.jwt, TTL);
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: env.APP_URL.startsWith('https'), path: '/', maxAge: TTL });
    return { ok: true, username: user.username, token };
  });

  /** Silent session check for the admin SPA (200 either way, no console noise on the login page). */
  app.get('/api/admin/session', async (req) => {
    const token = req.cookies?.[COOKIE];
    const payload = token ? jwtVerify(token, env.secrets.jwt) : null;
    return { authenticated: !!payload, username: payload?.name ?? null };
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);

    r.get('/api/admin/me', async (req) => ({ username: req.admin!.name }));

    r.post('/api/admin/password', async (req) => {
      const { current, next } = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }).parse(req.body);
      const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: req.admin!.sub } });
      if (!(await verifyPassword(current, user.passwordHash))) throw appError('UNAUTHORIZED', 401, 'Current password is wrong');
      await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
      return { ok: true };
    });

    // -------------------------------------------------------------- dashboard
    r.get('/api/admin/dashboard', async () => {
      const today = startOfToday();
      const [sessionsToday, paidToday, revenue, photosToday, completedToday, errorToday, printFailedToday, queue, uploadsPending, refundEvents, recentSessions, recentEvents, hourlyRaw, health] =
        await Promise.all([
          prisma.session.count({ where: { createdAt: { gte: today } } }),
          prisma.session.count({ where: { paidAt: { gte: today } } }),
          prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'PAID', paidAt: { gte: today } } }),
          prisma.photo.count({ where: { createdAt: { gte: today } } }),
          prisma.session.count({ where: { createdAt: { gte: today }, status: { in: ['QR_READY', 'FINISHED'] } } }),
          prisma.session.count({ where: { createdAt: { gte: today }, status: 'ERROR' } }),
          prisma.printJob.count({ where: { createdAt: { gte: today }, status: 'FAILED' } }),
          prisma.printJob.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: ['QUEUED', 'PRINTING', 'RETRYING', 'FAILED', 'RENDERING'] } } }),
          prisma.uploadJob.count({ where: { status: { in: ['PENDING', 'UPLOADING'] } } }),
          prisma.deviceEvent.count({ where: { event: { in: ['payment_after_cancel', 'payment_duplicate'] }, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } } }),
          prisma.session.findMany({ orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, sessionCode: true, status: true, amount: true, createdAt: true, paidAt: true, printQuantity: true } }),
          prisma.deviceEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }),
          prisma.payment.findMany({ where: { status: 'PAID', paidAt: { gte: today } }, select: { paidAt: true, amount: true } }),
          ctx.health.get(),
        ]);
      const hourly = Array.from({ length: 24 }, () => ({ sessions: 0, revenue: 0 }));
      for (const p of hourlyRaw) if (p.paidAt) {
        const h = p.paidAt.getHours();
        hourly[h].sessions++;
        hourly[h].revenue += p.amount;
      }
      return {
        today: {
          sessions: sessionsToday,
          paid: paidToday,
          revenue: revenue._sum.amount ?? 0,
          photos: photosToday,
          completed: completedToday,
          failed: errorToday + printFailedToday,
        },
        printQueue: Object.fromEntries(queue.map((q) => [q.status, q._count._all])),
        uploadsPending,
        refundsToReview: refundEvents,
        hourly,
        recentSessions,
        recentEvents,
        health,
      };
    });

    // -------------------------------------------------------------- sessions
    r.get('/api/admin/sessions', async (req) => {
      const q = z
        .object({
          status: z.string().max(30).optional(),
          q: z.string().max(40).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(5).max(100).default(25),
        })
        .parse(req.query);
      const where: Record<string, unknown> = {};
      if (q.status) where.status = q.status;
      if (q.q) where.OR = [{ sessionCode: { contains: q.q.toUpperCase() } }, { id: q.q }];
      if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
      const [items, total] = await Promise.all([
        prisma.session.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
          select: { id: true, sessionCode: true, status: true, amount: true, printQuantity: true, createdAt: true, paidAt: true, finishedAt: true, selectedTemplate: true, autoCompleted: true, errorCode: true, _count: { select: { photos: true } } },
        }),
        prisma.session.count({ where }),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    });

    r.get('/api/admin/sessions/:id', async (req) => {
      const { id } = req.params as { id: string };
      const s = await prisma.session.findUnique({ where: { id }, include: { ...FULL_INCLUDE, events: { orderBy: { createdAt: 'asc' } }, uploads: true } });
      if (!s) throw appError('SESSION_NOT_FOUND', 404, 'Session not found');
      const snapshot = buildSnapshot(s, ctx.media, (t) => ctx.gallery.url(t));
      const galleryUrl = s.galleryToken ? ctx.gallery.url(s.galleryToken) : null;
      return {
        snapshot,
        originals: Object.fromEntries(s.photos.map((p) => [p.id, ctx.media.url(p.originalPath, 3600)])),
        compositeUrl: s.compositePath ? ctx.media.url(s.compositePath, 3600) : null,
        printFileUrl: s.printFilePath ? ctx.media.url(s.printFilePath, 3600) : null,
        payments: s.payments,
        printJobs: s.printJobs,
        events: s.events,
        uploads: s.uploads.map((u) => ({ key: u.key, status: u.status, attempts: u.attempts, error: u.error })),
        gallery: galleryUrl ? { url: galleryUrl, expiresAt: s.galleryExpiresAt, qrSvg: await qrSvg(galleryUrl, 240) } : null,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        autoCompleted: s.autoCompleted,
      };
    });

    r.post('/api/admin/sessions/:id/cancel', async (req) => {
      const { id } = req.params as { id: string };
      await engine.adminCancel(id, req.admin!.name);
      return { ok: true };
    });

    r.post('/api/admin/sessions/:id/reprint', async (req) => {
      const { id } = req.params as { id: string };
      const { copies } = z.object({ copies: z.number().int().min(1).max(20).default(1) }).parse(req.body ?? {});
      const job = await engine.adminReprint(id, copies, req.admin!.name);
      return { ok: true, jobId: job.id };
    });

    r.post('/api/admin/sessions/:id/rerender', async (req) => {
      const { id } = req.params as { id: string };
      const out = await engine.adminRerender(id);
      return { ok: true, compositeUrl: ctx.media.url(out.compositeKey, 3600), printFileUrl: ctx.media.url(out.printKey, 3600) };
    });

    r.post('/api/admin/sessions/:id/regenerate-gallery', async (req) => {
      const { id } = req.params as { id: string };
      const g = await engine.adminRegenerateGallery(id, req.admin!.name);
      return { ok: true, url: g.url, expiresAt: g.expiresAt, qrSvg: await qrSvg(g.url, 240) };
    });

    r.post('/api/admin/sessions/:id/resume', async (req) => {
      const { id } = req.params as { id: string };
      const { target } = z.object({ target: z.enum(['REVIEW', 'READY', 'FINAL_PREVIEW', 'QR_READY']) }).parse(req.body);
      await engine.adminResume(id, target, req.admin!.name);
      return { ok: true };
    });

    // -------------------------------------------------------------- print queue
    r.get('/api/admin/print-jobs', async (req) => {
      const { status } = z.object({ status: z.string().max(20).optional() }).parse(req.query);
      return prisma.printJob.findMany({
        where: status ? { status: status as never } : {},
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { session: { select: { sessionCode: true } } },
      });
    });
    r.post('/api/admin/print-jobs/:id/retry', async (req) => {
      if (!(await ctx.printQueue.retry((req.params as { id: string }).id))) throw appError('INVALID_TRANSITION', 409, 'Job is not failed / retrying / cancelled');
      return { ok: true, message: 'Job re-queued' };
    });
    r.post('/api/admin/print-jobs/:id/cancel', async (req) => {
      await ctx.printQueue.cancel((req.params as { id: string }).id);
      return { ok: true };
    });

    r.get('/api/admin/upload-jobs', async () => prisma.uploadJob.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }));
    r.post('/api/admin/upload-jobs/retry-failed', async () => {
      const r2 = await prisma.uploadJob.updateMany({ where: { status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() } });
      return { ok: true, count: r2.count };
    });

    // -------------------------------------------------------------- settings
    r.get('/api/admin/settings', async () => ({
      settings: ctx.settings.get(),
      defaults: ctx.settings.defaults,
      overridden: Object.keys(ctx.settings.getOverrides()),
      sections: SETTINGS_SECTIONS,
      environment: {
        nodeEnv: env.NODE_ENV,
        paymentProvider: ctx.hardware.payment.name,
        storageProvider: env.STORAGE_PROVIDER,
        galleryMode: env.GALLERY_MODE,
        galleryBaseUrl: env.galleryBaseUrl,
        storagePath: env.storagePath,
        criticalComponents: [...env.criticalComponents],
      },
    }));

    r.put('/api/admin/settings/:section', async (req) => {
      const { section } = z.object({ section: z.enum(SETTINGS_SECTIONS as [SettingsSection, ...SettingsSection[]]) }).parse(req.params);
      const { value } = z.object({ value: z.unknown() }).parse(req.body);
      const next = await ctx.settings.update(section, value, req.admin!.name);
      await ctx.devices.info('system', 'settings_updated', `Settings "${section}" updated by ${req.admin!.name}`);
      void ctx.health.refresh();
      return { ok: true, settings: next };
    });

    r.delete('/api/admin/settings/:section', async (req) => {
      const { section } = z.object({ section: z.enum(SETTINGS_SECTIONS as [SettingsSection, ...SettingsSection[]]) }).parse(req.params);
      const next = await ctx.settings.reset(section);
      await ctx.devices.info('system', 'settings_reset', `Settings "${section}" reset by ${req.admin!.name}`);
      return { ok: true, settings: next };
    });

    // -------------------------------------------------------------- diagnostics
    r.get('/api/admin/diagnostics', async () => {
      const [health, robot, printer, printers] = await Promise.all([
        ctx.health.get(true),
        ctx.hardware.robotStatus(),
        ctx.hardware.printer.getStatus(),
        SystemPrinterProvider.listPrinters(),
      ]);
      return {
        health,
        camera: { driver: ctx.settings.get().camera.driver, server: ctx.hardware.camera?.getStatus() ?? null, browser: ctx.hardware.browserCamera, injectedFault: ctx.hardware.browserCameraFault },
        robot,
        printer,
        printers,
        payment: { provider: ctx.hardware.payment.name },
        mock: {
          payment: !!ctx.hardware.mockPayment,
          camera: ctx.settings.get().camera.driver === 'mock' || ctx.settings.get().camera.driver === 'webcam',
          robot: !!ctx.hardware.mockRobot,
          printer: !!ctx.hardware.mockPrinter,
          printerFault: ctx.hardware.mockPrinter?.currentFault ?? null,
        },
        angles: ctx.settings.get().angles,
        process: { uptime: process.uptime(), memory: process.memoryUsage().rss, node: process.version, platform: process.platform },
      };
    });

    r.post('/api/admin/diagnostics/test', async (req) => {
      const body = z
        .object({
          action: z.enum(['camera_connect', 'camera_capture', 'robot_connect', 'robot_home', 'robot_move', 'robot_stop', 'printer_test', 'payment_test', 'storage_test']),
          angle: z.number().int().min(1).max(100).optional(),
        })
        .parse(req.body);
      const started = Date.now();
      const done = (ok: boolean, message: string, extra: Record<string, unknown> = {}) => ({ ok, message, ms: Date.now() - started, ...extra });
      try {
        switch (body.action) {
          case 'camera_connect': {
            const cam = ctx.hardware.camera;
            if (!cam) return done(!!ctx.hardware.browserCamera, ctx.hardware.browserCamera ? `Webcam reported by booth: ${ctx.hardware.browserCamera.state}` : 'Webcam mode: no heartbeat from the booth yet');
            await cam.connect();
            return done(true, `Connected: ${cam.getStatus().model ?? cam.name}`);
          }
          case 'camera_capture': {
            const cam = ctx.hardware.camera;
            if (!cam) return done(false, 'Webcam mode: use the "Test webcam in this browser" button (capture runs in the booth browser).');
            const photo = await cam.capture({ angle: 0, shot: 0, sessionCode: 'TEST' });
            const key = `diagnostics/capture-${Date.now()}.jpg`;
            await ctx.store.put(key, photo.data);
            await ctx.devices.info('camera', 'test_capture', `Test capture ${photo.data.length} bytes`);
            return done(true, `Captured ${(photo.data.length / 1024).toFixed(0)} KB`, { imageUrl: ctx.media.url(key, 3600) });
          }
          case 'robot_connect':
            await ctx.hardware.robot.connect();
            return done(true, 'Robot connected');
          case 'robot_home':
            await ctx.hardware.robot.home();
            await ctx.devices.info('robot', 'test_home', 'Robot homed from admin');
            return done(true, 'Robot homed');
          case 'robot_move': {
            const angle = body.angle ?? 1;
            await ctx.hardware.robot.moveToAngle(angle);
            await ctx.devices.info('robot', 'test_move', `Robot moved to angle ${angle} from admin`);
            return done(true, `Robot moved to angle ${angle}`);
          }
          case 'robot_stop':
            await ctx.hardware.robot.stop();
            return done(true, 'Robot stopped');
          case 'printer_test': {
            const cfg = ctx.settings.get().printer;
            const key = await ctx.renderer.testPage(cfg);
            const job = await ctx.hardware.printer.print(ctx.store.resolve(key), 1, { widthPx: cfg.widthPx, heightPx: cfg.heightPx, dpi: cfg.dpi, documentName: `RobotPhotobooth-TEST-${Date.now()}` });
            await ctx.devices.info('printer', 'test_print', `Test page sent (${job.id})`);
            return done(true, `Test page sent to ${job.printer}`, { imageUrl: ctx.media.url(key, 3600), jobId: job.id });
          }
          case 'payment_test': {
            ctx.health.invalidatePaymentCache();
            const h = await ctx.hardware.payment.health();
            if (!h.ok) return done(false, h.message);
            const orderId = `TEST-${Date.now()}`;
            const p = await ctx.hardware.payment.createPayment({ orderId, amount: 1000, currency: 'IDR', description: 'Payment test', expiresInSeconds: 120 });
            await ctx.hardware.payment.cancelPayment?.(p.providerTransactionId, orderId).catch(() => undefined);
            return done(true, `${ctx.hardware.payment.name}: QR created and cancelled`, { qrSvg: await qrSvg(p.qrString, 200) });
          }
          case 'storage_test': {
            const key = `diagnostics/probe-${Date.now()}.txt`;
            await ctx.store.put(key, Buffer.from('ok'));
            const back = (await ctx.store.getBuffer(key)).toString();
            await ctx.store.delete(key);
            let remote = 'n/a';
            if (ctx.remote) {
              await ctx.remote.put(key, Buffer.from('ok'), 'text/plain');
              await ctx.remote.delete(key);
              remote = 'ok';
            }
            return done(back === 'ok', `Local: ${back === 'ok' ? 'ok' : 'failed'} · Cloud: ${remote}`);
          }
        }
      } catch (err) {
        return done(false, (err as Error).message);
      }
    });

    // -------------------------------------------------------------- mock controls
    r.post('/api/admin/mock', async (req) => {
      const body = z
        .discriminatedUnion('target', [
          z.object({ target: z.literal('payment'), action: z.enum(['success', 'failed', 'expired', 'unavailable', 'available']), sessionId: z.string().optional() }),
          z.object({ target: z.literal('camera'), action: z.enum(['capture_failure', 'disconnect', 'clear']) }),
          z.object({ target: z.literal('robot'), action: z.enum(['timeout', 'disconnected', 'clear']) }),
          z.object({ target: z.literal('printer'), action: z.enum(['offline', 'paper_out', 'ink_error', 'fail_next', 'clear']) }),
        ])
        .parse(req.body);
      let message = '';
      switch (body.target) {
        case 'payment': {
          const mock = ctx.hardware.mockPayment;
          if (!mock) throw appError('VALIDATION_ERROR', 400, 'Payment provider is not mock');
          if (body.action === 'unavailable' || body.action === 'available') {
            mock.simulateUnavailable(body.action === 'unavailable');
            ctx.health.invalidatePaymentCache();
            message = `Mock payment API ${body.action}`;
            break;
          }
          const session = body.sessionId
            ? await prisma.session.findUnique({ where: { id: body.sessionId } })
            : await prisma.session.findFirst({ where: { status: 'WAITING_PAYMENT' }, orderBy: { createdAt: 'desc' } });
          if (!session) throw appError('VALIDATION_ERROR', 400, 'No session waiting for payment');
          const payment = await prisma.payment.findFirst({ where: { sessionId: session.id, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
          if (!payment) throw appError('VALIDATION_ERROR', 400, 'Session has no pending payment');
          const status = body.action === 'success' ? 'PAID' : body.action === 'failed' ? 'FAILED' : 'EXPIRED';
          const res = await simulatePaymentWebhook(app, ctx, payment.orderId, status, payment.amount);
          message = `Webhook ${status} for ${payment.orderId} → HTTP ${res.statusCode}`;
          break;
        }
        case 'camera': {
          const mode = body.action === 'clear' ? null : body.action === 'disconnect' ? 'disconnect' : 'capture';
          if (ctx.hardware.camera) ctx.hardware.camera.simulateFailure(mode);
          else ctx.hardware.browserCameraFault = mode;
          message = `Camera fault: ${mode ?? 'cleared'}`;
          break;
        }
        case 'robot': {
          const robot = ctx.hardware.mockRobot;
          if (!robot) throw appError('VALIDATION_ERROR', 400, 'Robot driver is not mock');
          robot.simulateFault(body.action === 'clear' ? null : body.action);
          message = `Robot fault: ${body.action}`;
          break;
        }
        case 'printer': {
          const printer = ctx.hardware.mockPrinter;
          if (!printer) throw appError('VALIDATION_ERROR', 400, 'Printer driver is not mock');
          printer.simulateFault(body.action === 'clear' ? null : body.action);
          message = `Printer fault: ${body.action}`;
          break;
        }
      }
      await ctx.devices.info('system', 'mock_control', message, { by: req.admin!.name });
      void ctx.health.refresh();
      return { ok: true, message };
    });

    // -------------------------------------------------------------- logs
    r.get('/api/admin/events', async (req) => {
      const q = z
        .object({ device: z.string().max(20).optional(), level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(), sessionId: z.string().max(40).optional(), take: z.coerce.number().int().min(1).max(500).default(150) })
        .parse(req.query);
      return prisma.deviceEvent.findMany({
        where: { ...(q.device ? { device: q.device } : {}), ...(q.level ? { level: q.level } : {}), ...(q.sessionId ? { sessionId: q.sessionId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: q.take,
      });
    });

    r.get('/api/admin/webhooks', async () => prisma.webhookEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }));
  });
}
