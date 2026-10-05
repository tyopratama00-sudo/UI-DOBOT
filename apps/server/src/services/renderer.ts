import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  computeFrameLayout,
  computePageLayout,
  editColorMatrix,
  isIdentity,
  type ColorMatrix,
  type EditParams,
  type PhotoTemplate,
  type Settings,
} from '@photobooth/shared';
import type { LocalStorageProvider } from '@photobooth/storage';
import { REPO_ROOT } from '../env';

/**
 * High-resolution composite renderer.
 *
 * The browser preview is NOT what gets printed. This renderer recreates the
 * exact same frame geometry (shared `computeFrameLayout`) and the same photo
 * transform chain as the CSS preview —
 *   cover-fit to slot → brightness+filter colour matrix → flip → rotate →
 *   translate — from the untouched original files, at print resolution
 *   (e.g. 1200×1800 px @ 300 DPI), then lays the frame out on the print page.
 */

export interface RenderSlot {
  slotIndex: number;
  originalKey: string;
  edit: EditParams;
}

export interface RenderInput {
  sessionId: string;
  template: PhotoTemplate;
  slots: RenderSlot[];
  printer: Settings['printer'];
  label: string;
}

export interface RenderOutput {
  compositeKey: string;
  printKey: string;
  hash: string;
  width: number;
  height: number;
  reused: boolean;
}

const FONT_CANDIDATES = [
  path.join(REPO_ROOT, 'apps/server/assets/fonts/Fredoka-Variable.ttf'),
  path.join(process.cwd(), 'assets/fonts/Fredoka-Variable.ttf'),
];
const FONT_FILE = FONT_CANDIDATES.find((f) => fs.existsSync(f));

export function renderHash(input: RenderInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 3,
        t: input.template,
        s: input.slots.map((s) => [s.slotIndex, s.originalKey, s.edit]),
        p: [input.printer.widthPx, input.printer.heightPx, input.printer.dpi, input.printer.format],
        l: input.label,
      }),
    )
    .digest('hex')
    .slice(0, 24);
}

function parseColor(c: string): { r: number; g: number; b: number; alpha: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), alpha: 1 };
  }
  return { r: 255, g: 255, b: 255, alpha: 1 };
}

/** Applies an affine colour matrix to raw RGB(A) pixels in place (sRGB, clamped). */
export function applyMatrixRaw(buf: Buffer, channels: number, cm: ColorMatrix): void {
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = cm.m;
  const o0 = cm.o[0] * 255;
  const o1 = cm.o[1] * 255;
  const o2 = cm.o[2] * 255;
  for (let i = 0; i < buf.length; i += channels) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    const nr = m0 * r + m1 * g + m2 * b + o0;
    const ng = m3 * r + m4 * g + m5 * b + o1;
    const nb = m6 * r + m7 * g + m8 * b + o2;
    buf[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
    buf[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
    buf[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
  }
}

/** Renders one slot (RGBA, transparent where the photo does not cover it). */
export async function renderSlotImage(original: Buffer, slotW: number, slotH: number, edit: EditParams): Promise<Buffer> {
  const sw = Math.max(1, Math.round(slotW));
  const sh = Math.max(1, Math.round(slotH));
  const zw = Math.max(1, Math.round(sw * edit.zoom));
  const zh = Math.max(1, Math.round(sh * edit.zoom));

  // 1. cover-fit at zoomed size (object-fit: cover, then scale(z) around the centre)
  const fitted = await sharp(original, { failOn: 'none' })
    .rotate()
    .resize(zw, zh, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. brightness + filter
  const cm = editColorMatrix(edit.brightness, edit.filter);
  if (!isIdentity(cm)) applyMatrixRaw(fitted.data, fitted.info.channels, cm);

  // 3. flip + 4. rotate (transparent background)
  let img = sharp(fitted.data, { raw: { width: fitted.info.width, height: fitted.info.height, channels: fitted.info.channels } });
  if (edit.flipHorizontal) img = img.flop();
  const rot = ((edit.rotation % 360) + 360) % 360;
  const transformed =
    rot === 0
      ? await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      : await sharp(await img.ensureAlpha().png().toBuffer())
          .rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .raw()
          .toBuffer({ resolveWithObject: true });
  const tw = transformed.info.width;
  const th = transformed.info.height;

  // 5. translate: centre of the transformed image lands at slot centre + (x, y)
  const left = Math.round(sw / 2 + edit.x * sw - tw / 2);
  const top = Math.round(sh / 2 + edit.y * sh - th / 2);
  const ix0 = Math.max(0, left);
  const iy0 = Math.max(0, top);
  const ix1 = Math.min(sw, left + tw);
  const iy1 = Math.min(sh, top + th);
  const canvas = sharp({ create: { width: sw, height: sh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (ix1 <= ix0 || iy1 <= iy0) return canvas.png().toBuffer();
  const piece = await sharp(transformed.data, { raw: { width: tw, height: th, channels: 4 } })
    .extract({ left: ix0 - left, top: iy0 - top, width: ix1 - ix0, height: iy1 - iy0 })
    .png()
    .toBuffer();
  return canvas.composite([{ input: piece, left: ix0, top: iy0 }]).png().toBuffer();
}

function roundedMask(w: number, h: number, r: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
}

async function labelImage(text: string, color: string, fontSize: number, letterSpacing: number, maxW: number, maxH: number): Promise<Buffer | null> {
  const safe = text.replace(/[<>&]/g, '');
  if (!safe.trim()) return null;
  const spacing = Math.round(letterSpacing * 1024 * 0.75); // Pango units (1/1024 pt), px→pt at 96dpi
  if (FONT_FILE) {
    try {
      const img = await sharp({
        text: {
          text: `<span foreground="${color}" letter_spacing="${spacing}">${safe}</span>`,
          font: `Fredoka Bold ${Math.max(1, Math.round(fontSize * 0.75))}`,
          fontfile: FONT_FILE,
          rgba: true,
          dpi: 96,
        },
      })
        .png()
        .toBuffer({ resolveWithObject: true });
      if (img.info.width <= maxW && img.info.height <= maxH * 1.6) return img.data;
      return sharp(img.data).resize({ width: Math.floor(maxW), height: Math.floor(maxH), fit: 'inside' }).png().toBuffer();
    } catch {
      /* fall back to SVG text */
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(maxW)}" height="${Math.ceil(maxH)}"><text x="50%" y="78%" text-anchor="middle" font-family="Fredoka, 'Trebuchet MS', Arial, sans-serif" font-weight="700" font-size="${fontSize}" letter-spacing="${letterSpacing}" fill="${color}">${safe}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Renders the frame (template + photos + label) at the given pixel height. */
export async function renderFrame(
  template: PhotoTemplate,
  slots: { slotIndex: number; image: Buffer; edit: EditParams }[],
  height: number,
  label: string,
): Promise<Buffer> {
  const L = computeFrameLayout(template, height);
  const W = Math.round(L.width);
  const H = Math.round(L.height);
  const k = H / 740; // prototype preview scale reference (edit screen frame height)
  const bg = parseColor(template.background);

  // Decorations (polaroid ring + soft shadow) as one SVG layer.
  let decor = '';
  if (template.slotStyle === 'polaroid') {
    const blur = 16 * k;
    for (const s of L.slots) {
      const r = L.slotRadius + L.ring;
      decor += `<rect x="${s.x - L.ring + 8 * k}" y="${s.y - L.ring + 16 * k}" width="${s.w + 2 * L.ring - 16 * k}" height="${s.h + 2 * L.ring - 16 * k}" rx="${r}" fill="rgba(43,42,76,.4)" filter="url(#sh)"/>`;
      decor += `<rect x="${s.x - L.ring}" y="${s.y - L.ring}" width="${s.w + 2 * L.ring}" height="${s.h + 2 * L.ring}" rx="${r}" fill="#fff"/>`;
    }
    decor = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${blur / 2}"/></filter></defs>${decor}</svg>`;
  }

  const layers: sharp.OverlayOptions[] = [];
  if (decor) layers.push({ input: Buffer.from(decor), left: 0, top: 0 });

  for (const s of slots) {
    const rect = L.slots[s.slotIndex];
    if (!rect) continue;
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const w = Math.round(rect.x + rect.w) - x;
    const h = Math.round(rect.y + rect.h) - y;
    const slot = await renderSlotImage(s.image, w, h, s.edit);
    const masked = await sharp(slot)
      .composite([{ input: roundedMask(w, h, Math.round(L.slotRadius)), blend: 'dest-in' }])
      .png()
      .toBuffer();
    layers.push({ input: masked, left: x, top: y });
  }

  const lbl = await labelImage(label, template.labelColor || '#2B2A4C', L.label.fontSize, L.label.letterSpacing, L.label.w, L.label.h);
  if (lbl) {
    const m = await sharp(lbl).metadata();
    const lw = m.width ?? 0;
    const lh = m.height ?? 0;
    layers.push({
      input: lbl,
      left: Math.max(0, Math.round(L.label.x + (L.label.w - lw) / 2)),
      top: Math.max(0, Math.min(H - lh, Math.round(L.label.y + (L.label.h - lh) / 2))),
    });
  }

  return sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite(layers)
    .flatten({ background: bg })
    .png()
    .toBuffer();
}

export class Renderer {
  constructor(private readonly store: LocalStorageProvider) {}

  async render(input: RenderInput, previous?: { hash: string | null; compositeKey: string | null; printKey: string | null }): Promise<RenderOutput> {
    const hash = renderHash(input);
    const ext = input.printer.format === 'png' ? 'png' : 'jpg';
    const compositeKey = `sessions/${input.sessionId}/output/composite-${hash}.${ext}`;
    const printKey = `sessions/${input.sessionId}/output/print-${hash}.${ext}`;
    const page = computePageLayout(input.template, input.printer.widthPx, input.printer.heightPx);
    if (previous?.hash === hash && (await this.store.exists(compositeKey)) && (await this.store.exists(printKey))) {
      const m = await sharp(await this.store.getBuffer(compositeKey)).metadata();
      return { compositeKey, printKey, hash, width: m.width ?? 0, height: m.height ?? 0, reused: true };
    }

    const images = await Promise.all(input.slots.map(async (s) => ({ slotIndex: s.slotIndex, edit: s.edit, image: await this.store.getBuffer(s.originalKey) })));
    // Render the frame exactly at the size it occupies on the page (no resampling at print time).
    const frameH = Math.round(page.frameHeight);
    const frame = await renderFrame(input.template, images, frameH, input.label);
    const frameMeta = await sharp(frame).metadata();

    const encode = (img: sharp.Sharp) =>
      (input.printer.format === 'png' ? img.png({ compressionLevel: 6 }) : img.jpeg({ quality: 97, chromaSubsampling: '4:4:4', mozjpeg: false })).withMetadata({
        density: input.printer.dpi,
      });

    const composite = await encode(sharp(frame)).toBuffer();
    const placements = await Promise.all(
      page.placements.map(async (p) => ({
        input: await sharp(frame).resize(Math.round(p.w), Math.round(p.h), { fit: 'fill' }).png().toBuffer(),
        left: Math.round(p.x),
        top: Math.round(p.y),
      })),
    );
    const pageImg = await encode(
      sharp({ create: { width: input.printer.widthPx, height: input.printer.heightPx, channels: 3, background: '#ffffff' } }).composite(placements),
    ).toBuffer();

    await this.store.put(compositeKey, composite);
    await this.store.put(printKey, pageImg);
    return { compositeKey, printKey, hash, width: frameMeta.width ?? 0, height: frameMeta.height ?? 0, reused: false };
  }

  /** Simple test page for diagnostics "Print Test". */
  async testPage(printer: Settings['printer']): Promise<string> {
    const W = printer.widthPx;
    const H = printer.heightPx;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#FAF8F3"/><rect x="${W * 0.04}" y="${H * 0.04}" width="${W * 0.92}" height="${H * 0.92}" rx="${W * 0.04}" fill="none" stroke="#5B7CFA" stroke-width="${W * 0.01}"/><g font-family="Arial" font-weight="700" fill="#2B2A4C" text-anchor="middle"><text x="50%" y="40%" font-size="${W * 0.08}">ROBOT PHOTOBOOTH</text><text x="50%" y="50%" font-size="${W * 0.05}">PRINT TEST</text><text x="50%" y="58%" font-size="${W * 0.03}">${W}×${H}px @ ${printer.dpi} DPI</text><text x="50%" y="64%" font-size="${W * 0.03}">${new Date().toISOString()}</text></g>${['#FFC7DE', '#BDEBD3', '#DCCBFF', '#FFD9B0', '#7FD6F0', '#5B7CFA', '#FFD166', '#2B2A4C'].map((c, i) => `<rect x="${W * 0.1 + i * W * 0.1}" y="${H * 0.72}" width="${W * 0.1}" height="${H * 0.08}" fill="${c}"/>`).join('')}</svg>`;
    const key = `diagnostics/print-test-${Date.now()}.jpg`;
    await this.store.put(key, await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).withMetadata({ density: printer.dpi }).toBuffer());
    return key;
  }
}
