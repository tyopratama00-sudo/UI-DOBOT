/**
 * Photo filters. `css` strings are the prototype FIL constants (used for the
 * on-screen preview); `colorMatrix()` converts the same CSS filter chain into an
 * affine RGB matrix following the W3C Filter Effects spec so the server-side
 * renderer produces the same colours at print resolution.
 */

export const FILTER_IDS = ['original', 'warm', 'cool', 'mono', 'soft'] as const;
export type FilterId = (typeof FILTER_IDS)[number];

export interface FilterDef {
  id: FilterId;
  /** UI label (prototype FN) */
  label: string;
  css: string;
  /** robot reaction line when chosen */
  reaction: string;
}

export const FILTERS: FilterDef[] = [
  { id: 'original', label: 'Asli', css: '', reaction: 'Natural!' },
  { id: 'warm', label: 'Hangat', css: 'sepia(.5) saturate(1.3)', reaction: 'Hangat!' },
  { id: 'cool', label: 'Dingin', css: 'hue-rotate(-25deg) saturate(1.2)', reaction: 'Sejuk!' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1)', reaction: 'Hitam putih!' },
  { id: 'soft', label: 'Lembut', css: 'contrast(.9) brightness(1.1) saturate(.8)', reaction: 'Lembut!' },
];

export function filterById(id: string | null | undefined): FilterDef {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}

/** 3x3 matrix (row-major) + offset vector in 0..1 colour space. */
export interface ColorMatrix {
  m: [number, number, number, number, number, number, number, number, number];
  o: [number, number, number];
}

export const IDENTITY: ColorMatrix = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

/** result = b ∘ a  (apply a first, then b) */
export function compose(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const A = a.m;
  const B = b.m;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0] as ColorMatrix['m'];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) m[r * 3 + c] = B[r * 3] * A[c] + B[r * 3 + 1] * A[3 + c] + B[r * 3 + 2] * A[6 + c];
  const o: ColorMatrix['o'] = [0, 0, 0];
  for (let r = 0; r < 3; r++) o[r] = B[r * 3] * a.o[0] + B[r * 3 + 1] * a.o[1] + B[r * 3 + 2] * a.o[2] + b.o[r];
  return { m, o };
}

export function brightness(v: number): ColorMatrix {
  return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [0, 0, 0] };
}

export function contrast(v: number): ColorMatrix {
  const off = 0.5 - 0.5 * v;
  return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: [off, off, off] };
}

export function saturate(s: number): ColorMatrix {
  return {
    m: [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ],
    o: [0, 0, 0],
  };
}

export function sepia(amount: number): ColorMatrix {
  const a = 1 - Math.min(1, Math.max(0, amount));
  return {
    m: [
      0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
      0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
      0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a,
    ],
    o: [0, 0, 0],
  };
}

export function grayscale(amount: number): ColorMatrix {
  const a = 1 - Math.min(1, Math.max(0, amount));
  return {
    m: [
      0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
      0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
      0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a,
    ],
    o: [0, 0, 0],
  };
}

export function hueRotate(deg: number): ColorMatrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    m: [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ],
    o: [0, 0, 0],
  };
}

const FN_RE = /([a-z-]+)\(([-\d.]+)(deg)?\)/g;

/** Parse a CSS filter chain (subset used by the app) into a single matrix. */
export function cssFilterToMatrix(css: string): ColorMatrix {
  let acc = IDENTITY;
  for (const match of css.matchAll(FN_RE)) {
    const v = parseFloat(match[2]);
    let next: ColorMatrix;
    switch (match[1]) {
      case 'brightness': next = brightness(v); break;
      case 'contrast': next = contrast(v); break;
      case 'saturate': next = saturate(v); break;
      case 'sepia': next = sepia(v); break;
      case 'grayscale': next = grayscale(v); break;
      case 'hue-rotate': next = hueRotate(v); break;
      default: throw new Error(`Unsupported filter function ${match[1]}`);
    }
    acc = compose(acc, next);
  }
  return acc;
}

/** brightness(b) followed by the selected filter, like `filter:brightness(b) FIL[i]` in the prototype. */
export function editColorMatrix(brightnessValue: number, filter: FilterId): ColorMatrix {
  return compose(brightness(brightnessValue), cssFilterToMatrix(filterById(filter).css));
}

export function isIdentity(cm: ColorMatrix, eps = 1e-6): boolean {
  return cm.m.every((v, i) => Math.abs(v - IDENTITY.m[i]) < eps) && cm.o.every((v) => Math.abs(v) < eps);
}

export function applyColorMatrix(cm: ColorMatrix, rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = Math.min(1, Math.max(0, cm.m[i * 3] * r + cm.m[i * 3 + 1] * g + cm.m[i * 3 + 2] * b + cm.o[i]));
  return out;
}
