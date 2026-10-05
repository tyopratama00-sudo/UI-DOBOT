import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import archiver from 'archiver';
import type { Session } from '@photobooth/database';
import { sessionCommandSchema, type BoothConfig } from '@photobooth/shared';
import { contentTypeFor } from '@photobooth/storage';
import type { AppContext } from '../context';
import { appError } from '../errors';
import { safeEqual, verifyMedia } from '../util/crypto';
import { processWebhook } from '../services/workers';
import { photoFileName } from '../services/gallery';

export function boothConfig(ctx: AppContext): BoothConfig {
  const s = ctx.settings.get();
  const mode = ctx.hardware.cameraMode(s);
  const { digicamUrl: _a, gphoto2Bin: _b, captureCommand: _c, previewUrl: _d, ...camera } = s.camera;
  return {
    pricing: s.pricing,
    session: s.session,
    timeouts: s.timeouts,
    camera: {
      ...camera,
      mode,
      liveViewUrl: mode === 'server' && ctx.hardware.camera?.supportsPreview ? '/api/camera/live.mjpeg' : null,
    },
    templates: s.templates.filter((t) => t.enabled),
    angles: s.angles.map((a) => ({ id: a.id, name: a.name })),
    branding: s.branding,
    timingScale: ctx.env.isProd ? 1 : s.dev.timingScale,
    devTools: !ctx.env.isProd && ctx.env.DEV_TOOLS !== false,
    environment: ctx.env.NODE_ENV,
  };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Booth device key (optional): stored by the kiosk, never compiled into the bundle. */
export function checkBoothKey(ctx: AppContext, req: FastifyRequest) {
  const expected = ctx.env.BOOTH_DEVICE_KEY;
  if (!expected) return;
  const got = header(req, 'x-booth-key') ?? (req.query as Record<string, string | undefined>)?.key;
  if (!got || !safeEqual(got, expected)) throw appError('UNAUTHORIZED', 401, 'Invalid booth device key');
}

async function authSession(ctx: AppContext, req: FastifyRequest): Promise<Session> {
  const { id } = z.object({ id: z.string().min(10).max(40) }).parse(req.params);
  const s = await ctx.prisma.session.findUnique({ where: { id } });
  if (!s) throw appError('SESSION_NOT_FOUND', 404, 'Session not found');
  const token = header(req, 'x-session-token') ?? (req.query as Record<string, string | undefined>)?.token;
  if (!ctx.engine.verifyToken(s, token)) throw appError('UNAUTHORIZED', 401, 'Invalid session token');
  return s;
}

export async function qrSvg(text: string, size = 400): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: size, color: { dark: '#2B2A4C', light: '#FFFFFF' } });
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext) {
  const { engine, prisma } = ctx;

  // ---------------------------------------------------------------- booth
  app.get('/api/booth/config', async (req) => {
    checkBoothKey(ctx, req);
    return boothConfig(ctx);
  });

  app.get('/api/booth/health', async (req) => {
    checkBoothKey(ctx, req);
    const r = await ctx.health.get();
    // The booth only needs the verdict plus non-sensitive component states.
    return {
      ok: r.ok,
      acceptingSessions: r.acceptingSessions,
      checkedAt: r.checkedAt,
      components: Object.fromEntries(Object.entries(r.components).map(([k, c]) => [k, { status: c.status, critical: c.critical, message: c.message }])),
    };
  });

  app.post('/api/booth/heartbeat', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    checkBoothKey(ctx, req);
    const body = z
      .object({
        camera: z.object({ state: z.string().max(30), model: z.string().max(120).optional(), error: z.string().max(300).optional() }).optional(),
        screen: z.string().max(30).optional(),
        sessionId: z.string().max(40).nullable().optional(),
      })
      .parse(req.body ?? {});
    if (body.camera) {
      const prev = ctx.hardware.browserCamera?.state;
      ctx.hardware.browserCamera = { ...body.camera, reportedAt: Date.now(), screen: body.screen, userAgent: header(req, 'user-agent')?.slice(0, 200) };
      if (prev && prev !== body.camera.state && body.camera.state === 'error')
        void ctx.devices.error('camera', 'webcam_error', body.camera.error ?? 'Webcam error reported by booth', { sessionId: body.sessionId ?? null });
    }
    return { ok: true, cameraFault: ctx.hardware.browserCameraFault };
  });

  /** Recovery: hand the booth the active session (with a fresh token). */
  app.get('/api/booth/active', async (req) => {
    checkBoothKey(ctx, req);
    if (!ctx.env.BOOTH_DEVICE_KEY) {
      const ip = req.ip;
      const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (!local) return { session: null, token: null };
    }
    const s = await engine.findActive();
    if (!s) return { session: null, token: null };
    const token = await engine.rotateToken(s.id);
    return { session: await engine.snapshot(s.id), token };
  });

  // ---------------------------------------------------------------- sessions
  app.post('/api/sessions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkBoothKey(ctx, req);
    const { deviceId } = z.object({ deviceId: z.string().max(60).optional() }).parse(req.body ?? {});
    const { snapshot, token } = await engine.create(deviceId);
    return reply.status(201).send({ session: snapshot, token });
  });

  app.get('/api/sessions/:id', async (req) => {
    const s = await authSession(ctx, req);
    return engine.snapshot(s.id);
  });

  app.get('/api/sessions/:id/events', async (req, reply) => {
    const s = await authSession(ctx, req);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    let scheduled = false;
    const send = () => {
      if (closed || scheduled) return;
      scheduled = true;
      setTimeout(async () => {
        scheduled = false;
        if (closed) return;
        try {
          const snap = await engine.snapshot(s.id);
          raw.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        } catch {
          /* session deleted */
        }
      }, 40);
    };
    raw.write('retry: 2000\n\n');
    send();
    const off = ctx.bus.onSession(s.id, send);
    const hb = setInterval(() => !closed && raw.write(': ping\n\n'), 15000);
    req.raw.on('close', () => {
      closed = true;
      off();
      clearInterval(hb);
    });
  });

  app.post('/api/sessions/:id/payment', async (req) => {
    const s = await authSession(ctx, req);
    const { quantity } = z.object({ quantity: z.number().int().min(1).max(50) }).parse(req.body);
    return engine.createPayment(s.id, quantity, header(req, 'x-request-id'));
  });

  app.post('/api/sessions/:id/commands', async (req) => {
    const s = await authSession(ctx, req);
    const cmd = sessionCommandSchema.parse(req.body);
    return engine.command(s.id, cmd, header(req, 'x-request-id'));
  });

  /** Browser (webcam) capture upload. */
  app.post('/api/sessions/:id/photos', { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const s = await authSession(ctx, req);
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (!/^image\/(jpeg|png|webp)$/.test(part.mimetype)) throw appError('VALIDATION_ERROR', 400, 'Only JPEG/PNG/WebP images are accepted');
        file = await part.toBuffer();
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw appError('VALIDATION_ERROR', 400, 'Missing photo file');
    const { angle, shot } = z.object({ angle: z.coerce.number().int().min(0).max(19), shot: z.coerce.number().int().min(0).max(9) }).parse(fields);
    return engine.capture(s.id, angle, shot, file, header(req, 'x-request-id') ?? fields.requestId);
  });

  // ---------------------------------------------------------------- media (signed URLs)
  app.get('/media/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const q = req.query as { e?: string; s?: string; download?: string };
    if (!q.e || !q.s || !verifyMedia(key, Number(q.e), q.s, ctx.env.secrets.media)) throw appError('UNAUTHORIZED', 403, 'Invalid or expired media link');
    if (!(await ctx.store.exists(key))) throw appError('NOT_FOUND', 404, 'File not found');
    reply.header('content-type', contentTypeFor(key));
    reply.header('cache-control', 'private, max-age=3600');
    if (q.download) reply.header('content-disposition', `attachment; filename="${key.split('/').pop()}"`);
    return reply.send(await ctx.store.get(key));
  });

  // ---------------------------------------------------------------- live view (server cameras)
  app.get('/api/camera/live.mjpeg', async (req, reply) => {
    checkBoothKey(ctx, req);
    const cam = ctx.hardware.camera;
    if (!cam || !cam.supportsPreview) throw appError('NOT_FOUND', 404, 'Live view not available for this camera driver');
    reply.hijack();
    const raw = reply.raw;
    const boundary = 'pbframe';
    raw.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${boundary}`, 'cache-control': 'no-cache', connection: 'close' });
    const off = cam.subscribePreview((jpeg) => {
      raw.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      raw.write(jpeg);
      raw.write('\r\n');
    });
    req.raw.on('close', off);
  });

  // ---------------------------------------------------------------- payment webhooks (authoritative)
  app.post('/api/payments/webhook/:provider', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const r = await processWebhook(ctx, provider, {
      headers: req.headers as Record<string, string>,
      body: req.body,
      rawBody: (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {}),
    });
    return reply.status(r.status).send({ ok: r.ok, message: r.message });
  });

  // ---------------------------------------------------------------- mock payment page (dev / mock provider only)
  if (ctx.hardware.mockPayment) {
    app.get('/mock-pay/:orderId', async (req, reply) => {
      const { orderId } = z.object({ orderId: z.string().max(60) }).parse(req.params);
      const p = await prisma.payment.findUnique({ where: { orderId } });
      if (!p) return reply.status(404).type('text/html').send('<h1>Order not found</h1>');
      return reply.type('text/html').send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock QRIS</title><style>body{font-family:'Trebuchet MS',sans-serif;background:#FAF8F3;color:#2B2A4C;padding:24px;text-align:center}button{font:600 20px sans-serif;border:0;border-radius:20px;padding:18px 28px;margin:8px;cursor:pointer}.ok{background:#5B7CFA;color:#fff}.no{background:#FDE0DD;color:#F0564A}</style></head><body><h1>Mock QRIS</h1><p>Order <b>${orderId}</b></p><h2>Rp${p.amount.toLocaleString('id-ID')}</h2><p>Status: <b id="st">${p.status}</b></p><button class="ok" onclick="pay('PAID')">Bayar</button><button class="no" onclick="pay('FAILED')">Gagalkan</button><script>async function pay(s){const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:s})});document.getElementById('st').textContent=r.ok?s:'ERROR'}</script></body></html>`);
    });
    app.post('/mock-pay/:orderId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { orderId } = z.object({ orderId: z.string().max(60) }).parse(req.params);
      const { status } = z.object({ status: z.enum(['PAID', 'FAILED', 'EXPIRED']) }).parse(req.body);
      const p = await prisma.payment.findUnique({ where: { orderId } });
      if (!p) throw appError('NOT_FOUND', 404, 'Order not found');
      const res = await simulatePaymentWebhook(app, ctx, orderId, status, p.amount);
      return reply.status(res.statusCode).send(res.json());
    });
  }

  // ---------------------------------------------------------------- digital gallery
  const galleryLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/g/:token', galleryLimit, async (req, reply) => {
    const { token } = req.params as { token: string };
    const g = await ctx.gallery.resolve(token);
    reply.header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex');
    if (!g) return reply.status(404).type('text/html').send(ctx.gallery.renderExpired());
    if (g.expired) return reply.status(410).type('text/html').send(ctx.gallery.renderExpired());
    return reply.type('text/html').send(ctx.gallery.renderPage(g, ctx.gallery.serverLinks(token, g.session)));
  });

  const sendGalleryFile = async (reply: FastifyReply, key: string, expiresAt: Date, remoteKey: string | null, downloadName?: string) => {
    if (remoteKey) {
      const url = await ctx.gallery.remoteUrl(remoteKey, expiresAt);
      if (url) return reply.redirect(url, 302);
    }
    if (!(await ctx.store.exists(key))) throw appError('NOT_FOUND', 404, 'File not found');
    reply.header('content-type', contentTypeFor(key)).header('cache-control', 'private, max-age=600');
    if (downloadName) reply.header('content-disposition', `attachment; filename="${downloadName}"`);
    return reply.send(await ctx.store.get(key));
  };

  app.get('/g/:token/frame', galleryLimit, async (req, reply) => {
    const { token } = req.params as { token: string };
    const g = await ctx.gallery.resolve(token);
    if (!g || g.expired || !g.session.compositePath) throw appError('NOT_FOUND', g?.expired ? 410 : 404, 'Gallery not available');
    const ext = g.session.compositePath.split('.').pop();
    const dl = (req.query as { download?: string }).download ? `Frame_${g.session.sessionCode}.${ext}` : undefined;
    return sendGalleryFile(reply, g.session.compositePath, g.session.galleryExpiresAt!, ctx.remote ? `g/${token}/frame.${ext}` : null, dl);
  });

  app.get('/g/:token/p/:photoId/:variant', galleryLimit, async (req, reply) => {
    const { token, photoId, variant } = z
      .object({ token: z.string(), photoId: z.string().max(40), variant: z.enum(['preview', 'original']) })
      .parse(req.params);
    const g = await ctx.gallery.resolve(token);
    if (!g || g.expired) throw appError('NOT_FOUND', g?.expired ? 410 : 404, 'Gallery not available');
    const p = g.photos.find((x) => x.id === photoId);
    if (!p) throw appError('NOT_FOUND', 404, 'Photo not found');
    const name = photoFileName(p);
    const key = variant === 'original' ? p.originalPath : (p.previewPath ?? p.originalPath);
    const remoteKey = ctx.remote ? (variant === 'original' ? `g/${token}/photos/${name}` : `g/${token}/previews/${name.replace(/\.\w+$/, '.jpg')}`) : null;
    return sendGalleryFile(reply, key, g.session.galleryExpiresAt!, remoteKey, (req.query as { download?: string }).download ? name : undefined);
  });

  app.get('/g/:token/zip', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const g = await ctx.gallery.resolve(token);
    if (!g || g.expired) throw appError('NOT_FOUND', g?.expired ? 410 : 404, 'Gallery not available');
    if (ctx.remote) {
      const url = await ctx.gallery.remoteUrl(`g/${token}/photos.zip`, g.session.galleryExpiresAt!);
      if (url) return reply.redirect(url, 302);
    }
    const archive = archiver('zip', { zlib: { level: 1 } });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="RobotPhotobooth_${g.session.sessionCode}.zip"`);
    void ctx.gallery.appendToArchive(archive, g.session, g.photos).then(() => archive.finalize());
    return reply.send(archive);
  });
}

/** Builds a correctly signed mock webhook and sends it through the real webhook route. */
export async function simulatePaymentWebhook(app: FastifyInstance, ctx: AppContext, orderId: string, status: 'PAID' | 'FAILED' | 'EXPIRED', amount: number) {
  const mock = ctx.hardware.mockPayment;
  if (!mock) throw appError('VALIDATION_ERROR', 400, 'Payment provider is not mock');
  const { rawBody, headers } = mock.buildWebhook(orderId, status, amount);
  return app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers, payload: rawBody });
}
