import { z } from 'zod';
import { FILTER_IDS, type FilterId } from './filters';

/**
 * Non-destructive edit parameters for one frame slot.
 *
 * x / y are stored as a fraction of the slot width / height (the prototype stored
 * screen pixels, which made the result depend on preview size). The transform is
 * applied to the photo *after* it has been cover-fitted to the slot, in the same
 * order as the prototype CSS:
 *   translate(x, y) rotate(r) scale(flip ? -z : z, z)
 */
export const editParamsSchema = z.object({
  x: z.number().min(-5).max(5),
  y: z.number().min(-5).max(5),
  zoom: z.number().min(0.6).max(4),
  rotation: z.number().min(-3600).max(3600),
  flipHorizontal: z.boolean(),
  brightness: z.number().min(0.5).max(1.6),
  filter: z.enum(FILTER_IDS),
});
export type EditParams = z.infer<typeof editParamsSchema>;

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 4;
export const BRIGHTNESS_MIN = 0.5;
export const BRIGHTNESS_MAX = 1.6;

export function defaultEdit(): EditParams {
  return { x: 0, y: 0, zoom: 1, rotation: 0, flipHorizontal: false, brightness: 1, filter: 'original' };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export type EditOp =
  | { op: 'rotate90' }
  | { op: 'flip' }
  | { op: 'brightness'; delta: number }
  | { op: 'filter'; filter: FilterId }
  | { op: 'crop' }
  | { op: 'reset' };

/** Toolbar operations — identical semantics to the prototype `ed()` function. */
export function applyEditOp(e: EditParams, action: EditOp): EditParams {
  switch (action.op) {
    case 'rotate90':
      return { ...e, rotation: (e.rotation + 90) % 360 };
    case 'flip':
      return { ...e, flipHorizontal: !e.flipHorizontal };
    case 'brightness':
      return { ...e, brightness: round(clamp(e.brightness + action.delta, BRIGHTNESS_MIN, BRIGHTNESS_MAX), 2) };
    case 'filter':
      return { ...e, filter: action.filter };
    case 'crop':
      // "Potong" cycles the crop zoom 1 → 1.25 → 1.5 → 1
      return { ...e, zoom: e.zoom >= 1.5 ? 1 : round(e.zoom + 0.25, 2) };
    case 'reset':
      return defaultEdit();
  }
}

/** One-finger drag. Deltas in the same unit as slotW/slotH (stage pixels). */
export function applyDrag(base: EditParams, dx: number, dy: number, slotW: number, slotH: number): EditParams {
  return { ...base, x: round(clamp(base.x + dx / slotW, -5, 5)), y: round(clamp(base.y + dy / slotH, -5, 5)) };
}

/** Two-finger pinch + twist + pan. */
export function applyPinch(
  base: EditParams,
  scale: number,
  rotateDeg: number,
  panX: number,
  panY: number,
  slotW: number,
  slotH: number,
): EditParams {
  return {
    ...base,
    zoom: round(clamp(base.zoom * scale, ZOOM_MIN, ZOOM_MAX)),
    rotation: round(base.rotation + rotateDeg, 2),
    x: round(clamp(base.x + panX / slotW, -5, 5)),
    y: round(clamp(base.y + panY / slotH, -5, 5)),
  };
}

/** Mouse wheel zoom (desktop / admin preview). */
export function applyWheel(base: EditParams, deltaY: number): EditParams {
  const factor = Math.exp(-deltaY * 0.0015);
  return { ...base, zoom: round(clamp(base.zoom * factor, ZOOM_MIN, ZOOM_MAX)) };
}

/** CSS transform for the preview element of a slot of the given pixel size. */
export function cssTransform(e: EditParams, slotW: number, slotH: number): string {
  const sx = e.flipHorizontal ? -e.zoom : e.zoom;
  return `translate(${(e.x * slotW).toFixed(2)}px,${(e.y * slotH).toFixed(2)}px) rotate(${e.rotation}deg) scale(${sx},${e.zoom})`;
}

/** Axis-aligned visible window in normalized cover-image coordinates (ignores rotation). */
export function visibleCrop(e: EditParams): { x: number; y: number; w: number; h: number } {
  const w = 1 / e.zoom;
  const h = 1 / e.zoom;
  const cx = 0.5 + (e.flipHorizontal ? e.x : -e.x) / e.zoom;
  const cy = 0.5 - e.y / e.zoom;
  return { x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h) };
}

export function isDefaultEdit(e: EditParams): boolean {
  const d = defaultEdit();
  return (Object.keys(d) as (keyof EditParams)[]).every((k) => e[k] === d[k]);
}
