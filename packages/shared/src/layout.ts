import type { PhotoTemplate } from './templates';

/**
 * Pure frame geometry. Used by the booth (CSS absolute positioning) AND by the
 * server-side high-resolution renderer, so what the customer sees on screen is
 * exactly what gets printed, just at a different scale.
 *
 * Reproduces the prototype `.fr` grid: padding 5%, gap 5%,
 * `grid-template-rows: repeat(rows,1fr) auto` with a "ROBOT PHOTOBOOTH" label row
 * whose font size is min(h/36, w/21) and letter-spacing .16em.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** ellipse/circle slot (overlay frames) */
  round?: boolean;
}

export interface FrameLayout {
  width: number;
  height: number;
  padding: number;
  slots: Rect[];
  label: Rect & { fontSize: number; letterSpacing: number };
  slotRadius: number;
  /** White "polaroid" ring thickness (0 when not polaroid). */
  ring: number;
}

export const LABEL_LINE_HEIGHT = 1.25;

export function frameWidthForHeight(t: Pick<PhotoTemplate, 'aspectRatio'>, height: number): number {
  return height * (t.aspectRatio || 0.667);
}

export function computeFrameLayout(
  t: Pick<PhotoTemplate, 'photoCount' | 'columns' | 'rows' | 'aspectRatio' | 'slotStyle'> & Partial<Pick<PhotoTemplate, 'overlay'>>,
  height: number,
): FrameLayout {
  if (t.overlay) {
    const k = height / t.overlay.height;
    const width = t.overlay.width * k;
    return {
      width,
      height,
      padding: 0,
      slots: t.overlay.slots.map((s) => ({ x: s.x * k, y: s.y * k, w: s.width * k, h: s.height * k, round: s.shape === 'ellipse' || s.shape === 'circle' })),
      label: { x: 0, y: 0, w: 0, h: 0, fontSize: 0, letterSpacing: 0 },
      slotRadius: 0,
      ring: 0,
    };
  }
  const width = frameWidthForHeight(t, height);
  const cols = Math.max(1, t.columns);
  const rows = Math.max(1, t.rows || Math.ceil(t.photoCount / cols));
  const padding = width * 0.05;
  const cw = width - padding * 2;
  const ch = height - padding * 2;
  const fontSize = Math.min(height / 36, width / 21);
  const labelH = fontSize * LABEL_LINE_HEIGHT;
  const colGap = cw * 0.05;
  const rowGap = ch * 0.05;
  const slotW = (cw - (cols - 1) * colGap) / cols;
  const slotH = (ch - labelH - rows * rowGap) / rows;
  const slots: Rect[] = [];
  for (let i = 0; i < t.photoCount; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    slots.push({ x: padding + c * (slotW + colGap), y: padding + r * (slotH + rowGap), w: slotW, h: slotH });
  }
  const labelY = padding + rows * (slotH + rowGap);
  return {
    width,
    height,
    padding,
    slots,
    label: { x: padding, y: labelY, w: cw, h: labelH, fontSize, letterSpacing: fontSize * 0.16 },
    slotRadius: t.slotStyle === 'rounded' ? height / 24 : height / 72,
    ring: t.slotStyle === 'polaroid' ? height / 100 : 0,
  };
}

/** Frame corner radius used by `.fr{border-radius:22px}` scaled to height (22px @ 740px). */
export function frameRadius(height: number): number {
  return (height * 22) / 740;
}

/**
 * Print page layout. Narrow frames (strips) are printed two-up side by side on
 * the page and cut, like real photobooth printers (2x6 strips on 4x6 media).
 */
export interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  placements: Rect[];
  frameHeight: number;
}

export function computePageLayout(
  t: Pick<PhotoTemplate, 'aspectRatio'>,
  pageWidth: number,
  pageHeight: number,
): PageLayout {
  // Fill page height; if the frame is narrower than half the page, repeat it.
  let frameHeight = pageHeight;
  let frameWidth = frameWidthForHeight(t, frameHeight);
  if (frameWidth > pageWidth) {
    frameWidth = pageWidth;
    frameHeight = frameWidth / t.aspectRatio;
  }
  const copies = Math.max(1, Math.floor(pageWidth / frameWidth));
  const usable = copies >= 2 ? 2 : 1;
  const totalW = frameWidth * usable;
  const gapX = (pageWidth - totalW) / (usable + 1);
  const y = (pageHeight - frameHeight) / 2;
  const placements: Rect[] = [];
  for (let i = 0; i < usable; i++) {
    placements.push({ x: gapX + i * (frameWidth + gapX), y, w: frameWidth, h: frameHeight });
  }
  return { pageWidth, pageHeight, placements, frameHeight };
}
