import { z } from 'zod';
import { DEFAULT_TEMPLATES, templatesSchema } from './templates';

/**
 * Runtime configuration. Defaults come from environment variables (see the
 * server's env loader) and every section can be overridden from the admin panel
 * (persisted in the AppSetting table). Secrets (API keys, passwords) are NEVER
 * part of these settings: they stay in the server environment only.
 */

export const angleConfigSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1).max(40),
  /** Opaque physical coordinates forwarded to the robot controller. */
  position: z.record(z.union([z.number(), z.string(), z.boolean()])),
  /** Extra wait after the robot reports arrival (vibration settle). */
  settleMs: z.number().int().min(0).max(10000).optional(),
});
export type AngleConfig = z.infer<typeof angleConfigSchema>;

export const DEFAULT_ANGLES: AngleConfig[] = [
  { id: 1, name: 'Front', position: { pan: 0, tilt: 0, height: 140, distance: 160 } },
  { id: 2, name: 'Front Left', position: { pan: -30, tilt: 0, height: 140, distance: 160 } },
  { id: 3, name: 'Left', position: { pan: -60, tilt: 5, height: 150, distance: 170 } },
  { id: 4, name: 'High Front', position: { pan: 0, tilt: -20, height: 190, distance: 170 } },
  { id: 5, name: 'Low Front', position: { pan: 0, tilt: 15, height: 100, distance: 160 } },
  { id: 6, name: 'Right', position: { pan: 60, tilt: 5, height: 150, distance: 170 } },
  { id: 7, name: 'Front Right', position: { pan: 30, tilt: 0, height: 140, distance: 160 } },
  { id: 8, name: 'Close Up', position: { pan: 0, tilt: 0, height: 145, distance: 110 } },
  { id: 9, name: 'Wide', position: { pan: 0, tilt: 0, height: 150, distance: 230 } },
  { id: 10, name: 'Top Down', position: { pan: 0, tilt: -35, height: 210, distance: 150 } },
];

export const CAMERA_DRIVERS = ['webcam', 'mock', 'gphoto2', 'digicamcontrol', 'command'] as const;
export const ROBOT_DRIVERS = ['mock', 'serial', 'tcp', 'websocket', 'rest', 'mqtt'] as const;
export const PRINTER_DRIVERS = ['mock', 'system'] as const;

const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const settingsSchema = z.object({
  pricing: z.object({
    firstPrint: z.number().int().min(0).max(10_000_000),
    additionalPrint: z.number().int().min(0).max(10_000_000),
    maxQuantity: z.number().int().min(1).max(50),
    currency: z.string().length(3),
  }),
  session: z.object({
    angles: z.number().int().min(1).max(20),
    shotsPerAngle: z.number().int().min(1).max(5),
    countdownSeconds: z.number().int().min(1).max(10),
    readySeconds: z.number().int().min(0).max(30),
    retakeLimit: z.number().int().min(0).max(20),
    maxCaptureRetries: z.number().int().min(0).max(10),
  }),
  timeouts: z.object({
    paymentSeconds: z.number().int().min(30).max(3600),
    selectionSeconds: z.number().int().min(15).max(3600),
    editingSeconds: z.number().int().min(15).max(3600),
    finalSeconds: z.number().int().min(15).max(3600),
    qrSeconds: z.number().int().min(10).max(3600),
    thanksSeconds: z.number().int().min(3).max(600),
    warningSeconds: z.number().int().min(3).max(120),
    errorResetSeconds: z.number().int().min(10).max(3600),
  }),
  camera: z.object({
    driver: z.enum(CAMERA_DRIVERS),
    previewFit: z.enum(['cover', 'contain']),
    mirrorPreview: z.boolean(),
    previewRotation: rotation,
    captureRotation: rotation,
    mirrorCapture: z.boolean(),
    deviceId: z.string().max(200),
    width: z.number().int().min(320).max(8192),
    height: z.number().int().min(240).max(8192),
    jpegQuality: z.number().min(0.5).max(1),
    digicamUrl: z.string().max(300),
    gphoto2Bin: z.string().max(300),
    captureCommand: z.string().max(1000),
    previewUrl: z.string().max(300),
  }),
  printer: z.object({
    driver: z.enum(PRINTER_DRIVERS),
    name: z.string().max(200),
    widthPx: z.number().int().min(300).max(20000),
    heightPx: z.number().int().min(300).max(20000),
    dpi: z.number().int().min(72).max(1200),
    secondsPerCopy: z.number().int().min(1).max(600),
    maxAttempts: z.number().int().min(1).max(10),
    format: z.enum(['jpeg', 'png']),
  }),
  robot: z.object({
    driver: z.enum(ROBOT_DRIVERS),
    host: z.string().max(200),
    port: z.number().int().min(0).max(65535),
    serialPort: z.string().max(200),
    baudRate: z.number().int().min(1200).max(2_000_000),
    url: z.string().max(300),
    mqttTopic: z.string().max(200),
    moveTimeoutMs: z.number().int().min(500).max(120_000),
    retries: z.number().int().min(0).max(10),
    settleMs: z.number().int().min(0).max(10_000),
  }),
  gallery: z.object({
    expirationHours: z.number().int().min(1).max(24 * 365),
  }),
  payment: z.object({
    expiryMinutes: z.number().int().min(1).max(120),
  }),
  branding: z.object({
    label: z.string().max(40),
    welcomeChip: z.string().max(80),
  }),
  templates: templatesSchema,
  angles: z.array(angleConfigSchema).min(1).max(20),
  dev: z.object({
    /** Multiplies every UI wait (prototype "⚡ Cepat" used 0.1). Ignored in production. */
    timingScale: z.number().min(0.01).max(2),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;
export const SETTINGS_SECTIONS = Object.keys(settingsSchema.shape) as SettingsSection[];

export const DEFAULT_SETTINGS: Settings = {
  pricing: { firstPrint: 65000, additionalPrint: 15000, maxQuantity: 10, currency: 'IDR' },
  session: { angles: 10, shotsPerAngle: 2, countdownSeconds: 3, readySeconds: 5, retakeLimit: 2, maxCaptureRetries: 2 },
  timeouts: {
    paymentSeconds: 300,
    selectionSeconds: 120,
    editingSeconds: 180,
    finalSeconds: 90,
    qrSeconds: 90,
    thanksSeconds: 12,
    warningSeconds: 15,
    errorResetSeconds: 90,
  },
  camera: {
    driver: 'webcam',
    previewFit: 'cover',
    mirrorPreview: true,
    previewRotation: 0,
    captureRotation: 0,
    mirrorCapture: false,
    deviceId: '',
    width: 1920,
    height: 1080,
    jpegQuality: 0.95,
    digicamUrl: 'http://127.0.0.1:5513',
    gphoto2Bin: 'gphoto2',
    captureCommand: '',
    previewUrl: '',
  },
  printer: {
    driver: 'mock',
    name: '',
    widthPx: 1200,
    heightPx: 1800,
    dpi: 300,
    secondsPerCopy: 15,
    maxAttempts: 3,
    format: 'jpeg',
  },
  robot: {
    driver: 'mock',
    host: '127.0.0.1',
    port: 9000,
    serialPort: 'COM3',
    baudRate: 115200,
    url: '',
    mqttTopic: 'photobooth/robot',
    moveTimeoutMs: 15000,
    retries: 2,
    settleMs: 300,
  },
  gallery: { expirationHours: 24 },
  payment: { expiryMinutes: 5 },
  branding: { label: 'ROBOT PHOTOBOOTH', welcomeChip: 'Studio foto otomatis · 10 sudut' },
  templates: DEFAULT_TEMPLATES,
  angles: DEFAULT_ANGLES,
  dev: { timingScale: 1 },
};

/** Deep-merge partial overrides (one level per section, arrays replaced). */
export function mergeSettings(base: Settings, overrides: Partial<Record<SettingsSection, unknown>>): Settings {
  const out: Record<string, unknown> = { ...base };
  for (const key of SETTINGS_SECTIONS) {
    const o = overrides[key];
    if (o === undefined || o === null) continue;
    const b = (base as Record<string, unknown>)[key];
    out[key] = Array.isArray(b) || Array.isArray(o) ? o : { ...(b as object), ...(o as object) };
  }
  return settingsSchema.parse(out);
}
