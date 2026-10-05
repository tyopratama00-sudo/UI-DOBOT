import path from 'node:path';
import type { Logger } from 'pino';
import { createServerCamera, type ServerCameraDriver } from '@photobooth/camera/node';
import { createRobotController, MockRobotController, type RobotController, type RobotStatus } from '@photobooth/robot';
import { createPrinter, MockPrinterProvider, type PrinterProvider } from '@photobooth/printer';
import { createPaymentProvider, MockPaymentProvider, type PaymentProvider } from '@photobooth/payments';
import type { CameraMode, Settings } from '@photobooth/shared';
import type { Env } from '../env';
import type { DeviceLog } from './device-log';

export interface BrowserCameraReport {
  state: string;
  model?: string;
  error?: string;
  reportedAt: number;
  screen?: string;
  userAgent?: string;
}

/**
 * Owns every hardware / third-party adapter and rebuilds them when the admin
 * changes driver settings. A background supervisor reconnects devices that
 * dropped (USB unplugged, robot controller rebooted, …).
 */
export class HardwareManager {
  camera: ServerCameraDriver | null = null;
  robot!: RobotController;
  printer!: PrinterProvider;
  payment!: PaymentProvider;
  browserCamera: BrowserCameraReport | null = null;
  /** Fault injected into the booth webcam (admin "Simulate Camera Failure"). */
  browserCameraFault: 'capture' | 'disconnect' | null = null;

  private cameraKey = '';
  private robotKey = '';
  private printerKey = '';
  private supervisor: NodeJS.Timeout | null = null;
  private lastRobotState = '';
  private lastCameraState = '';

  constructor(
    private readonly env: Env,
    private readonly log: Logger,
    private readonly devices: DeviceLog,
  ) {
    this.payment = createPaymentProvider({
      provider: env.PAYMENT_PROVIDER,
      mockWebhookSecret: env.MOCK_WEBHOOK_SECRET,
      mockPayUrlBase: env.MOCK_PAY_URL_BASE || env.APP_URL,
      midtransServerKey: env.MIDTRANS_SERVER_KEY,
      midtransProduction: env.MIDTRANS_PRODUCTION,
      midtransAcquirer: env.MIDTRANS_QRIS_ACQUIRER,
      xenditSecretKey: env.XENDIT_SECRET_KEY,
      xenditCallbackToken: env.XENDIT_CALLBACK_TOKEN,
    });
  }

  get mockPayment(): MockPaymentProvider | null {
    return this.payment instanceof MockPaymentProvider ? this.payment : null;
  }
  get mockRobot(): MockRobotController | null {
    return this.robot instanceof MockRobotController ? this.robot : null;
  }
  get mockPrinter(): MockPrinterProvider | null {
    return this.printer instanceof MockPrinterProvider ? this.printer : null;
  }

  cameraMode(settings: Settings): CameraMode {
    if (settings.camera.driver === 'webcam') return 'browser';
    if (settings.camera.driver === 'mock') return 'mock';
    return 'server';
  }

  async apply(settings: Settings): Promise<void> {
    const camKey = JSON.stringify([settings.camera.driver, settings.camera.digicamUrl, settings.camera.gphoto2Bin, settings.camera.captureCommand, settings.camera.previewUrl]);
    if (camKey !== this.cameraKey) {
      this.cameraKey = camKey;
      await this.camera?.disconnect().catch(() => undefined);
      this.camera = createServerCamera(settings.camera);
      if (this.camera) void this.connectCamera();
      this.log.info({ event: 'camera_driver', driver: settings.camera.driver }, 'camera driver configured');
    }

    const r = settings.robot;
    const robotKey = JSON.stringify([r.driver, r.host, r.port, r.serialPort, r.baudRate, r.url, r.mqttTopic, r.moveTimeoutMs]);
    if (robotKey !== this.robotKey) {
      this.robotKey = robotKey;
      await this.robot?.disconnect().catch(() => undefined);
      this.robot = createRobotController({
        ...r,
        token: this.env.ROBOT_TOKEN,
        mqttUsername: this.env.ROBOT_MQTT_USERNAME,
        mqttPassword: this.env.ROBOT_MQTT_PASSWORD,
      });
      void this.connectRobot();
      this.log.info({ event: 'robot_driver', driver: r.driver }, 'robot driver configured');
    }
    this.robot.setAngles(settings.angles.map((a) => ({ ...a, settleMs: a.settleMs ?? r.settleMs })));

    const p = settings.printer;
    const printerKey = JSON.stringify([p.driver, p.name, p.secondsPerCopy]);
    if (printerKey !== this.printerKey) {
      this.printerKey = printerKey;
      this.printer = createPrinter({ driver: p.driver, name: p.name, secondsPerCopy: p.secondsPerCopy, spoolDir: path.join(this.env.storagePath, 'print-spool') });
      this.log.info({ event: 'printer_driver', driver: p.driver, name: p.name }, 'printer configured');
    }
  }

  private async connectCamera() {
    if (!this.camera) return;
    try {
      await this.camera.connect();
      await this.devices.info('camera', 'camera_connected', `Camera connected (${this.camera.getStatus().model ?? this.camera.name})`);
    } catch (err) {
      await this.devices.error('camera', 'camera_connect_failed', (err as Error).message);
    }
  }

  private async connectRobot() {
    try {
      await this.robot.connect();
      await this.devices.info('robot', 'robot_connected', `Robot connected (${this.robot.driver})`);
    } catch (err) {
      await this.devices.error('robot', 'robot_connect_failed', (err as Error).message);
    }
  }

  async robotStatus(): Promise<RobotStatus> {
    try {
      return await this.robot.getStatus();
    } catch (err) {
      return { state: 'error', connected: false, driver: this.robot.driver, angle: null, lastError: (err as Error).message, updatedAt: new Date().toISOString() };
    }
  }

  /** Background reconnection loop. */
  startSupervisor(intervalMs = 10000) {
    if (this.supervisor) return;
    const tick = async () => {
      const rs = await this.robotStatus();
      if (rs.state !== this.lastRobotState) {
        if (['disconnected', 'error'].includes(rs.state) && this.lastRobotState)
          await this.devices.warn('robot', 'robot_disconnected', `Robot state: ${rs.state}${rs.lastError ? ` (${rs.lastError})` : ''}`);
        this.lastRobotState = rs.state;
      }
      if (['disconnected', 'error'].includes(rs.state)) await this.robot.connect().catch(() => undefined);

      if (this.camera) {
        const cs = this.camera.getStatus();
        if (cs.state !== this.lastCameraState) {
          if (cs.state === 'error' && this.lastCameraState) await this.devices.warn('camera', 'camera_disconnected', cs.lastError ?? 'Camera error');
          this.lastCameraState = cs.state;
        }
        if (['disconnected', 'error'].includes(cs.state)) await this.camera.connect().catch(() => undefined);
      }
    };
    this.supervisor = setInterval(() => void tick().catch(() => undefined), intervalMs);
  }

  async shutdown() {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = null;
    await this.camera?.disconnect().catch(() => undefined);
    await this.robot?.disconnect().catch(() => undefined);
  }
}
