import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { DEFAULT_SETTINGS, settingsSchema, type Settings, angleConfigSchema } from '@photobooth/shared';

/** Repository root (works for `tsx src/index.ts` and for the bundled `dist/index.js`). */
export function findRepoRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'robot-photobooth') return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : parseInt(v, 10)))
    .pipe(z.number().int());
const optInt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : parseInt(v, 10)));
const str = (d = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : v));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: str('0.0.0.0'),
  PORT: int(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_URL: str('http://localhost:8080'),
  API_URL: str(''),
  PUBLIC_GALLERY_URL: str(''),
  CORS_ORIGINS: str(''),
  TRUST_PROXY: bool,

  JWT_SECRET: str(''),
  MEDIA_SIGNING_SECRET: str(''),
  BOOTH_DEVICE_KEY: str(''),
  ADMIN_USERNAME: str('admin'),
  ADMIN_PASSWORD: str(''),

  PAYMENT_PROVIDER: z.enum(['mock', 'midtrans', 'xendit']).default('mock'),
  MOCK_WEBHOOK_SECRET: str('mock-webhook-secret-change-me'),
  MOCK_PAY_URL_BASE: str(''),
  MIDTRANS_SERVER_KEY: str(''),
  MIDTRANS_PRODUCTION: bool,
  MIDTRANS_QRIS_ACQUIRER: str('gopay'),
  XENDIT_SECRET_KEY: str(''),
  XENDIT_CALLBACK_TOKEN: str(''),
  PAYMENT_EXPIRY_MINUTES: optInt,

  CAMERA_DRIVER: z.enum(['webcam', 'mock', 'gphoto2', 'digicamcontrol', 'command']).optional(),
  CAMERA_PREVIEW_FIT: z.enum(['cover', 'contain']).optional(),
  CAMERA_MIRROR_PREVIEW: bool,
  CAMERA_PREVIEW_ROTATION: optInt,
  CAMERA_CAPTURE_ROTATION: optInt,
  CAMERA_MIRROR_CAPTURE: bool,
  CAMERA_DEVICE_ID: z.string().optional(),
  CAMERA_WIDTH: optInt,
  CAMERA_HEIGHT: optInt,
  CAMERA_DIGICAM_URL: z.string().optional(),
  CAMERA_GPHOTO2_BIN: z.string().optional(),
  CAMERA_CAPTURE_COMMAND: z.string().optional(),
  CAMERA_PREVIEW_URL: z.string().optional(),

  ROBOT_DRIVER: z.enum(['mock', 'serial', 'tcp', 'websocket', 'rest', 'mqtt']).optional(),
  ROBOT_HOST: z.string().optional(),
  ROBOT_PORT: optInt,
  ROBOT_SERIAL_PORT: z.string().optional(),
  ROBOT_BAUD_RATE: optInt,
  ROBOT_URL: z.string().optional(),
  ROBOT_TOKEN: str(''),
  ROBOT_MQTT_TOPIC: z.string().optional(),
  ROBOT_MQTT_USERNAME: str(''),
  ROBOT_MQTT_PASSWORD: str(''),
  ROBOT_MOVE_TIMEOUT_MS: optInt,
  ROBOT_ANGLES_FILE: str('config/angles.json'),

  PRINTER_DRIVER: z.enum(['mock', 'system']).optional(),
  PRINTER_NAME: z.string().optional(),
  PRINT_WIDTH_PX: optInt,
  PRINT_HEIGHT_PX: optInt,
  PRINT_DPI: optInt,
  PRINT_SECONDS_PER_COPY: optInt,
  PRINT_FORMAT: z.enum(['jpeg', 'png']).optional(),

  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: str('./storage'),
  S3_BUCKET: str(''),
  S3_REGION: str('auto'),
  S3_ENDPOINT: str(''),
  S3_ACCESS_KEY_ID: str(''),
  S3_SECRET_ACCESS_KEY: str(''),
  S3_FORCE_PATH_STYLE: bool,
  S3_PREFIX: str(''),
  S3_PUBLIC_URL: str(''),
  GALLERY_MODE: z.enum(['server', 'static']).default('server'),

  PHOTO_ANGLES: optInt,
  SHOTS_PER_ANGLE: optInt,
  COUNTDOWN_SECONDS: optInt,
  READY_SECONDS: optInt,
  RETAKE_LIMIT: optInt,
  PRICE_FIRST_PRINT: optInt,
  PRICE_ADDITIONAL_PRINT: optInt,
  MAX_PRINT_QUANTITY: optInt,
  GALLERY_EXPIRATION_HOURS: optInt,

  TIMING_SCALE: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v) : undefined)),
  DEV_TOOLS: bool,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_DIR: str('./logs'),
  LOG_PRETTY: bool,
  DATA_RETENTION_DAYS: int(30),
  INTERNET_CHECK_URL: str('https://www.google.com/generate_204'),
  CRITICAL_COMPONENTS: str('database,storage,camera,robot,printer,payment'),
  WORKERS: bool,
});

export type Env = z.infer<typeof envSchema> & {
  storagePath: string;
  logDir: string;
  galleryBaseUrl: string;
  secrets: { jwt: string; media: string };
  criticalComponents: Set<string>;
  isProd: boolean;
};

let cached: Env | null = null;

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });
  const raw = { ...process.env, ...overrides };
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const jwt = e.JWT_SECRET || (isProd ? '' : 'dev-only-jwt-secret-do-not-use-in-production');
  const media = e.MEDIA_SIGNING_SECRET || (isProd ? '' : 'dev-only-media-secret-do-not-use-in-production');
  if (isProd) {
    const missing: string[] = [];
    if (jwt.length < 32) missing.push('JWT_SECRET (min 32 chars)');
    if (media.length < 32) missing.push('MEDIA_SIGNING_SECRET (min 32 chars)');
    if (e.PAYMENT_PROVIDER === 'mock' && e.MOCK_WEBHOOK_SECRET === 'mock-webhook-secret-change-me')
      missing.push('MOCK_WEBHOOK_SECRET (must be changed when using the mock provider in production)');
    if (missing.length) throw new Error(`Missing production secrets:\n  ${missing.join('\n  ')}`);
  }
  const storagePath = path.resolve(REPO_ROOT, e.STORAGE_PATH);
  const env: Env = {
    ...e,
    isProd,
    storagePath,
    logDir: path.resolve(REPO_ROOT, e.LOG_DIR),
    galleryBaseUrl: (e.PUBLIC_GALLERY_URL || e.APP_URL).replace(/\/+$/, ''),
    secrets: { jwt, media },
    criticalComponents: new Set(e.CRITICAL_COMPONENTS.split(',').map((s) => s.trim()).filter(Boolean)),
  };
  cached = env;
  return env;
}

export function getEnv(): Env {
  return cached ?? loadEnv();
}

/** Settings defaults = code defaults overridden by environment variables. */
export function settingsFromEnv(env: Env): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  const set = <T>(v: T | undefined, apply: (v: T) => void) => {
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) apply(v);
  };
  set(env.PRICE_FIRST_PRINT, (v) => (s.pricing.firstPrint = v));
  set(env.PRICE_ADDITIONAL_PRINT, (v) => (s.pricing.additionalPrint = v));
  set(env.MAX_PRINT_QUANTITY, (v) => (s.pricing.maxQuantity = v));
  set(env.PHOTO_ANGLES, (v) => (s.session.angles = v));
  set(env.SHOTS_PER_ANGLE, (v) => (s.session.shotsPerAngle = v));
  set(env.COUNTDOWN_SECONDS, (v) => (s.session.countdownSeconds = v));
  set(env.READY_SECONDS, (v) => (s.session.readySeconds = v));
  set(env.RETAKE_LIMIT, (v) => (s.session.retakeLimit = v));
  set(env.GALLERY_EXPIRATION_HOURS, (v) => (s.gallery.expirationHours = v));
  set(env.PAYMENT_EXPIRY_MINUTES, (v) => (s.payment.expiryMinutes = v));

  set(env.CAMERA_DRIVER, (v) => (s.camera.driver = v));
  set(env.CAMERA_PREVIEW_FIT, (v) => (s.camera.previewFit = v));
  set(env.CAMERA_MIRROR_PREVIEW, (v) => (s.camera.mirrorPreview = v));
  set(env.CAMERA_PREVIEW_ROTATION, (v) => (s.camera.previewRotation = v as 0));
  set(env.CAMERA_CAPTURE_ROTATION, (v) => (s.camera.captureRotation = v as 0));
  set(env.CAMERA_MIRROR_CAPTURE, (v) => (s.camera.mirrorCapture = v));
  set(env.CAMERA_DEVICE_ID, (v) => (s.camera.deviceId = v));
  set(env.CAMERA_WIDTH, (v) => (s.camera.width = v));
  set(env.CAMERA_HEIGHT, (v) => (s.camera.height = v));
  set(env.CAMERA_DIGICAM_URL, (v) => (s.camera.digicamUrl = v));
  set(env.CAMERA_GPHOTO2_BIN, (v) => (s.camera.gphoto2Bin = v));
  set(env.CAMERA_CAPTURE_COMMAND, (v) => (s.camera.captureCommand = v));
  set(env.CAMERA_PREVIEW_URL, (v) => (s.camera.previewUrl = v));

  set(env.ROBOT_DRIVER, (v) => (s.robot.driver = v));
  set(env.ROBOT_HOST, (v) => (s.robot.host = v));
  set(env.ROBOT_PORT, (v) => (s.robot.port = v));
  set(env.ROBOT_SERIAL_PORT, (v) => (s.robot.serialPort = v));
  set(env.ROBOT_BAUD_RATE, (v) => (s.robot.baudRate = v));
  set(env.ROBOT_URL, (v) => (s.robot.url = v));
  set(env.ROBOT_MQTT_TOPIC, (v) => (s.robot.mqttTopic = v));
  set(env.ROBOT_MOVE_TIMEOUT_MS, (v) => (s.robot.moveTimeoutMs = v));

  set(env.PRINTER_DRIVER, (v) => (s.printer.driver = v));
  set(env.PRINTER_NAME, (v) => (s.printer.name = v));
  set(env.PRINT_WIDTH_PX, (v) => (s.printer.widthPx = v));
  set(env.PRINT_HEIGHT_PX, (v) => (s.printer.heightPx = v));
  set(env.PRINT_DPI, (v) => (s.printer.dpi = v));
  set(env.PRINT_SECONDS_PER_COPY, (v) => (s.printer.secondsPerCopy = v));
  set(env.PRINT_FORMAT, (v) => (s.printer.format = v));

  set(env.TIMING_SCALE, (v) => (s.dev.timingScale = v));

  // Physical robot angles from config/angles.json (if present).
  const anglesFile = path.resolve(REPO_ROOT, env.ROBOT_ANGLES_FILE);
  if (fs.existsSync(anglesFile)) {
    try {
      const json = JSON.parse(fs.readFileSync(anglesFile, 'utf8'));
      const list = Array.isArray(json) ? json : json.angles;
      s.angles = z.array(angleConfigSchema).min(1).parse(list);
    } catch (err) {
      throw new Error(`Invalid ${env.ROBOT_ANGLES_FILE}: ${(err as Error).message}`);
    }
  }
  return settingsSchema.parse(s);
}
