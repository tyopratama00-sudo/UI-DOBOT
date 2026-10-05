import { describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_TEMPLATES, defaultEdit, findTemplate } from '@photobooth/shared';
import { JsonLineRobotController, MockRobotController, RobotError, TcpTransport } from '@photobooth/robot';
import { mapWindowsJobStatus, mapWindowsPrinterStatus, MockPrinterProvider, PrinterError } from '@photobooth/printer';
import { JpegStreamSplitter, MockCameraDriver, splitCommand } from '@photobooth/camera/node';
import { applyMatrixRaw, renderFrame, renderSlotImage } from '../../src/services/renderer';
import { editColorMatrix } from '@photobooth/shared';

describe('mock camera', () => {
  it('produces a real 2400×1800 JPEG and supports fault injection', async () => {
    const cam = new MockCameraDriver();
    await cam.connect();
    const p = await cam.capture({ angle: 0, shot: 1, sessionCode: 'T' });
    const m = await sharp(p.data).metadata();
    expect([m.format, m.width, m.height]).toEqual(['jpeg', 2400, 1800]);
    cam.simulateFailure('capture');
    await expect(cam.capture()).rejects.toThrow(/simulated/);
    cam.simulateFailure(null);
  });
  it('splits MJPEG streams into frames and parses command lines', () => {
    const frames: Buffer[] = [];
    const s = new JpegStreamSplitter((f) => frames.push(f));
    const jpg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    s.push(Buffer.concat([Buffer.from('--b\r\n'), jpg.subarray(0, 3)]));
    s.push(Buffer.concat([jpg.subarray(3), Buffer.from('\r\n'), jpg]));
    expect(frames).toHaveLength(2);
    expect(splitCommand('"C:\\Program Files\\x.exe" /capture /filename {output}')).toEqual(['C:\\Program Files\\x.exe', '/capture', '/filename', '{output}']);
  });
});

describe('robot controllers', () => {
  const angles = [1, 2, 3].map((id) => ({ id, name: `A${id}`, position: { pan: id * 10 } }));

  it('mock robot moves, homes and injects faults', async () => {
    const r = new MockRobotController({ msPerStep: 5, minMoveMs: 5, timeoutMs: 5 });
    r.setAngles(angles);
    await r.connect();
    await r.moveToAngle(3);
    expect((await r.getStatus()).angle).toBe(3);
    await expect(r.moveToAngle(99)).rejects.toBeInstanceOf(RobotError);
    r.simulateFault('timeout');
    await expect(r.moveToAngle(1)).rejects.toMatchObject({ code: 'ROBOT_TIMEOUT' });
    r.simulateFault(null);
    await r.home();
  });

  it('TCP line-JSON protocol round-trips move/home and surfaces errors & timeouts', async () => {
    const received: Record<string, unknown>[] = [];
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          received.push(msg);
          if (msg.cmd === 'move' && msg.angle === 2) sock.write(JSON.stringify({ id: msg.id, ok: false, error: 'limit switch' }) + '\n');
          else if (msg.cmd === 'move' && msg.angle === 3) {
            /* never answer → timeout */
          } else setTimeout(() => sock.write(JSON.stringify({ id: msg.id, ok: true, state: 'idle', angle: msg.angle ?? null }) + '\n'), 10);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const robot = new JsonLineRobotController('tcp', new TcpTransport('127.0.0.1', port), { moveTimeoutMs: 300, commandTimeoutMs: 300 });
    robot.setAngles(angles);
    await robot.connect();
    await robot.moveToAngle(1);
    expect(received.find((m) => m.cmd === 'move')).toMatchObject({ angle: 1, name: 'A1', position: { pan: 10 } });
    await expect(robot.moveToAngle(2)).rejects.toMatchObject({ code: 'ROBOT_REJECTED' });
    await expect(robot.moveToAngle(3)).rejects.toMatchObject({ code: 'ROBOT_TIMEOUT' });
    await robot.home();
    await robot.disconnect();
    server.close();
  });
});

describe('printers', () => {
  it('maps Windows spooler states', () => {
    expect(mapWindowsPrinterStatus('Normal', false)).toBe('ready');
    expect(mapWindowsPrinterStatus('Normal', true)).toBe('offline');
    expect(mapWindowsPrinterStatus('PaperOut', false)).toBe('paper_out');
    expect(mapWindowsPrinterStatus('NoToner', false)).toBe('ink_error');
    expect(mapWindowsPrinterStatus('Offline', false)).toBe('offline');
    expect(mapWindowsPrinterStatus('Printing', false)).toBe('printing');
    expect(mapWindowsJobStatus('Error, Printing')).toBe('PRINT_FAILED');
    expect(mapWindowsJobStatus('Spooling')).toBeNull();
  });
  it('mock printer spools the file, reports progress and simulated faults', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-print-'));
    const file = path.join(dir, 'page.jpg');
    await fs.writeFile(file, 'x');
    const p = new MockPrinterProvider({ spoolDir: path.join(dir, 'spool'), secondsPerCopy: 0.2 as unknown as number });
    const job = await p.print(file, 1);
    expect((await fs.readdir(path.join(dir, 'spool'))).length).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await p.getJobStatus(job.id)).state).toBe('completed');
    p.simulateFault('paper_out');
    expect((await p.getStatus()).state).toBe('paper_out');
    await expect(p.print(file, 1)).rejects.toBeInstanceOf(PrinterError);
  });
});

describe('high-resolution renderer', () => {
  const photo = () =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 60, b: 60 } } })
      .jpeg()
      .toBuffer();

  it('renders a slot at exact pixel size with transparent margins when zoomed out', async () => {
    const out = await renderSlotImage(await photo(), 400, 300, { ...defaultEdit(), zoom: 0.6 });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([400, 300, 4]);
    expect(data[3]).toBe(0); // top-left corner transparent
    const c = (150 * 400 + 200) * 4;
    expect(data[c + 3]).toBe(255); // centre covered
  });

  it('applies the colour matrix exactly like the CSS filter (mono)', () => {
    const px = Buffer.from([200, 60, 60, 255]);
    applyMatrixRaw(px, 4, editColorMatrix(1, 'mono'));
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
  });

  it('renders a full frame at print height with the template size', async () => {
    const t = findTemplate(DEFAULT_TEMPLATES, 'kotak-ceria')!;
    const img = await photo();
    const png = await renderFrame(t, [0, 1, 2, 3].map((i) => ({ slotIndex: i, image: img, edit: { ...defaultEdit(), rotation: i * 10 } })), 1800, 'ROBOT PHOTOBOOTH');
    const m = await sharp(png).metadata();
    expect(m.height).toBe(1800);
    expect(m.width).toBe(Math.round(1800 * t.aspectRatio));
  });
});
