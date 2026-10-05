import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { STATIC_DIRS, type AppContext } from './context';
import { REPO_ROOT } from './env';
import { errorHandler } from './errors';
import { registerAdminRoutes } from './routes/admin';
import { registerPublicRoutes } from './routes/public';

export async function buildApp(ctx: AppContext, opts: { serveStatic?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: ctx.env.TRUST_PROXY ?? false,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: ctx.env.NODE_ENV === 'test',
    genReqId: () => Math.random().toString(36).slice(2, 10),
  });

  // Keep the raw JSON body (payment webhook signatures are computed over it).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.setErrorHandler(errorHandler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  const origins = ctx.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 40 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // The kiosk itself talks to the server over loopback all day long.
    allowList: (req) => ctx.env.NODE_ENV === 'test' || req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
  });

  app.get('/api/health', async () => {
    const h = await ctx.health.get();
    return { ok: h.ok, acceptingSessions: h.acceptingSessions, checkedAt: h.checkedAt };
  });

  registerPublicRoutes(app, ctx);
  registerAdminRoutes(app, ctx);

  if (opts.serveStatic !== false) {
    const dirs = STATIC_DIRS(REPO_ROOT);
    const hasBooth = fs.existsSync(path.join(dirs.booth, 'index.html'));
    const hasAdmin = fs.existsSync(path.join(dirs.admin, 'index.html'));
    if (hasBooth) await app.register(fastifyStatic, { root: dirs.booth, prefix: '/', wildcard: true, index: ['index.html'] });
    if (hasAdmin) await app.register(fastifyStatic, { root: dirs.admin, prefix: '/admin/', decorateReply: !hasBooth, wildcard: true, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0];
      if (req.method === 'GET' && hasAdmin && (url === '/admin' || url.startsWith('/admin/'))) {
        return reply.type('text/html').send(fs.createReadStream(path.join(dirs.admin, 'index.html')));
      }
      if (req.method === 'GET' && hasBooth && !/^\/(api|media|g|mock-pay)(\/|$)/.test(url)) {
        return reply.type('text/html').send(fs.createReadStream(path.join(dirs.booth, 'index.html')));
      }
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  }

  return app;
}
