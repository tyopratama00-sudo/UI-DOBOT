import path from 'node:path';
import type { Logger } from 'pino';
import { prisma as defaultPrisma, type PrismaClient } from '@photobooth/database';
import { createStorage, LocalStorageProvider, type StorageProvider } from '@photobooth/storage';
import { settingsFromEnv, type Env } from './env';
import { createLogger } from './logger';
import { EventBus } from './services/bus';
import { DeviceLog } from './services/device-log';
import { SessionEngine } from './services/engine';
import { GalleryService } from './services/gallery';
import { HardwareManager } from './services/hardware';
import { HealthService } from './services/health';
import { MediaService } from './services/media';
import { PrintQueue } from './services/print-queue';
import { Renderer } from './services/renderer';
import { SettingsService } from './services/settings';
import { PaymentReconciler, SessionReaper, UploadQueue } from './services/workers';
import { hashPassword } from './util/crypto';

export interface AppContext {
  env: Env;
  log: Logger;
  prisma: PrismaClient;
  bus: EventBus;
  settings: SettingsService;
  devices: DeviceLog;
  hardware: HardwareManager;
  store: LocalStorageProvider;
  remote: StorageProvider | null;
  media: MediaService;
  renderer: Renderer;
  gallery: GalleryService;
  engine: SessionEngine;
  health: HealthService;
  printQueue: PrintQueue;
  reconciler: PaymentReconciler;
  uploads: UploadQueue;
  reaper: SessionReaper;
}

export async function createContext(env: Env, opts: { prisma?: PrismaClient; log?: Logger } = {}): Promise<AppContext> {
  const log = opts.log ?? createLogger(env);
  const prisma = opts.prisma ?? defaultPrisma;
  const bus = new EventBus();
  const settings = new SettingsService(prisma, settingsFromEnv(env), bus);
  await settings.load();
  const devices = new DeviceLog(prisma, log);
  const hardware = new HardwareManager(env, log, devices);
  await hardware.apply(settings.get());
  bus.onSettings(() => void hardware.apply(settings.get()).catch((err) => log.error({ err }, 'hardware_reconfigure_failed')));

  // Working storage is always local (offline-safe). Cloud storage replicates gallery files.
  const store = new LocalStorageProvider(env.storagePath);
  const remote =
    env.STORAGE_PROVIDER === 's3'
      ? createStorage({
          provider: 's3',
          localPath: env.storagePath,
          s3: {
            bucket: env.S3_BUCKET,
            region: env.S3_REGION,
            endpoint: env.S3_ENDPOINT || undefined,
            accessKeyId: env.S3_ACCESS_KEY_ID || undefined,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY || undefined,
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            prefix: env.S3_PREFIX || undefined,
            publicUrl: env.S3_PUBLIC_URL || undefined,
          },
        })
      : null;

  const media = new MediaService(store, env.secrets.media);
  const renderer = new Renderer(store);
  const gallery = new GalleryService(prisma, env, settings, store, remote, log);
  const health = new HealthService(env, prisma, hardware, settings, store, remote, log, devices);
  const engine = new SessionEngine({
    prisma,
    env,
    settings,
    hardware,
    media,
    store,
    renderer,
    gallery,
    bus,
    log,
    devices,
    isAcceptingSessions: () => health.acceptingSessions(),
  });
  const printQueue = new PrintQueue(prisma, hardware, settings, store, engine, bus, log, devices);
  const reconciler = new PaymentReconciler(prisma, hardware, engine, log);
  const uploads = new UploadQueue(prisma, store, remote, health, log, devices);
  const reaper = new SessionReaper(prisma, engine, hardware, settings, store, env.DATA_RETENTION_DAYS, log);

  return { env, log, prisma, bus, settings, devices, hardware, store, remote, media, renderer, gallery, engine, health, printQueue, reconciler, uploads, reaper };
}

export async function ensureAdmin(ctx: AppContext) {
  const count = await ctx.prisma.adminUser.count();
  if (count > 0) return;
  const password = ctx.env.ADMIN_PASSWORD || (ctx.env.isProd ? '' : 'admin12345');
  if (!password) {
    ctx.log.warn('No admin user exists and ADMIN_PASSWORD is not set — the admin panel is locked until you set it.');
    return;
  }
  await ctx.prisma.adminUser.create({ data: { username: ctx.env.ADMIN_USERNAME, passwordHash: await hashPassword(password) } });
  ctx.log.info({ username: ctx.env.ADMIN_USERNAME, devDefault: !ctx.env.ADMIN_PASSWORD }, 'admin user created');
}

export async function startWorkers(ctx: AppContext) {
  await ctx.printQueue.recoverInterrupted();
  ctx.printQueue.start();
  ctx.reconciler.start();
  await ctx.uploads.start();
  ctx.reaper.start();
  ctx.health.start();
  ctx.hardware.startSupervisor();
}

export async function stopWorkers(ctx: AppContext) {
  await ctx.printQueue.stop();
  ctx.reconciler.stop();
  ctx.uploads.stop();
  ctx.reaper.stop();
  ctx.health.stop();
  await ctx.hardware.shutdown();
}

export const STATIC_DIRS = (root: string) => ({
  booth: path.join(root, 'apps/booth/dist'),
  admin: path.join(root, 'apps/admin/dist'),
});
