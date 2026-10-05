import { describe, expect, it } from 'vitest';
import { clampQuantity, priceFor, rp, DEFAULT_PRICING } from '../src/pricing';
import { DEFAULT_TEMPLATES, findTemplate, templatesSchema } from '../src/templates';
import { computeFrameLayout, computePageLayout } from '../src/layout';
import { activePhotos, autoPick, canRetake, capturePlan, chooseForAngle, nextMissingStep, retakesLeft, togglePick } from '../src/selection';
import { applyDrag, applyEditOp, applyPinch, applyWheel, cssTransform, defaultEdit, visibleCrop } from '../src/edit';
import { applyColorMatrix, cssFilterToMatrix, editColorMatrix, isIdentity } from '../src/filters';
import { tipFor, TIPS } from '../src/poses';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/config';

describe('pricing', () => {
  it('matches the prototype: Rp65.000 first print, +Rp15.000 each, max 10', () => {
    expect(priceFor(1)).toBe(65000);
    expect(priceFor(2)).toBe(80000);
    expect(priceFor(10)).toBe(200000);
    expect(() => priceFor(11)).toThrow(RangeError);
    expect(() => priceFor(0)).toThrow(RangeError);
    expect(() => priceFor(1.5)).toThrow(RangeError);
  });
  it('is configurable', () => {
    expect(priceFor(3, { ...DEFAULT_PRICING, firstPrint: 50000, additionalPrint: 10000 })).toBe(70000);
  });
  it('clamps and formats', () => {
    expect(clampQuantity(0)).toBe(1);
    expect(clampQuantity(99)).toBe(10);
    expect(clampQuantity(Number.NaN)).toBe(1);
    expect(rp(65000)).toBe('Rp65.000');
  });
});

describe('frame templates & layout', () => {
  it('keeps all six prototype frames', () => {
    expect(DEFAULT_TEMPLATES.map((t) => t.name)).toEqual(['Duo Mini', 'Strip Klasik', 'Kotak Ceria', 'Enam Momen', 'Taman Mint', 'Galeri Robot']);
    expect(DEFAULT_TEMPLATES.map((t) => t.photoCount)).toEqual([2, 4, 4, 6, 6, 8]);
    expect(templatesSchema.safeParse(DEFAULT_TEMPLATES).success).toBe(true);
  });
  it('rejects duplicate ids and impossible grids', () => {
    const dup = [DEFAULT_TEMPLATES[0], { ...DEFAULT_TEMPLATES[1], id: DEFAULT_TEMPLATES[0].id }];
    expect(templatesSchema.safeParse(dup).success).toBe(false);
    expect(templatesSchema.safeParse([{ ...DEFAULT_TEMPLATES[0], columns: 1, rows: 1 }]).success).toBe(false);
  });
  it('finds a template by id', () => {
    expect(findTemplate(DEFAULT_TEMPLATES, 'kotak-ceria')?.name).toBe('Kotak Ceria');
    expect(findTemplate(DEFAULT_TEMPLATES, 'nope')).toBeUndefined();
  });
  for (const t of DEFAULT_TEMPLATES) {
    it(`lays out ${t.name} slots inside the frame without overlap`, () => {
      const L = computeFrameLayout(t, 1800);
      expect(L.slots).toHaveLength(t.photoCount);
      expect(L.width).toBeCloseTo(1800 * t.aspectRatio);
      for (const s of L.slots) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x + s.w).toBeLessThanOrEqual(L.width + 1e-6);
        expect(s.y + s.h).toBeLessThanOrEqual(L.label.y + 1e-6);
        expect(s.w).toBeGreaterThan(0);
        expect(s.h).toBeGreaterThan(0);
      }
      for (let i = 0; i < L.slots.length; i++)
        for (let j = i + 1; j < L.slots.length; j++) {
          const a = L.slots[i];
          const b = L.slots[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
      expect(L.label.y + L.label.h).toBeLessThanOrEqual(L.height + 1e-6);
    });
  }
  it('prints narrow strips two-up on a 4x6 page and scales wide frames to fit', () => {
    const strip = computePageLayout(findTemplate(DEFAULT_TEMPLATES, 'strip-klasik')!, 1200, 1800);
    expect(strip.placements).toHaveLength(2);
    const mint = computePageLayout(findTemplate(DEFAULT_TEMPLATES, 'taman-mint')!, 1200, 1800);
    expect(mint.placements).toHaveLength(1);
    expect(mint.placements[0].w).toBeLessThanOrEqual(1200);
  });
});

describe('photo selection & retake', () => {
  const photos = [...Array(10).keys()].flatMap((a) => [0, 1].map((s) => ({ id: `${a}_${s}`, angle: a, shot: s, selected: true })));

  it('flat() orders active photos by angle then shot', () => {
    const shuffled = [...photos].reverse();
    expect(activePhotos(shuffled).map((p) => p.id).slice(0, 3)).toEqual(['0_0', '0_1', '1_0']);
  });
  it('autoFp spreads picks over the session like the prototype', () => {
    const ids = photos.map((p) => p.id);
    expect(autoPick(ids, 4)).toEqual(['0_0', '2_1', '5_0', '7_1']);
    expect(autoPick(ids, 2)).toEqual(['0_0', '5_0']);
    expect(new Set(autoPick(ids, 8)).size).toBe(8);
    expect(autoPick(['a', 'b'], 4)).toEqual(['a', 'b']);
  });
  it('togglePick drops the oldest pick when the frame is full', () => {
    let r = togglePick([], 'a', 2);
    r = togglePick(r.picks, 'b', 2);
    r = togglePick(r.picks, 'c', 2);
    expect(r.picks).toEqual(['b', 'c']);
    r = togglePick(r.picks, 'b', 2);
    expect(r).toEqual({ picks: ['c'], added: false });
  });
  it('chooseForAngle keeps exactly shotsPerAngle photos (pilih 2 dari 4)', () => {
    expect(chooseForAngle(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
    expect(chooseForAngle(['a', 'b'], 'a', 2)).toEqual(['a', 'b']);
  });
  it('enforces the retake limit of 2 angles and no double retake', () => {
    expect(canRetake([], 3, 2, 10)).toBe(true);
    expect(canRetake([3], 3, 2, 10)).toBe(false);
    expect(canRetake([3, 4], 5, 2, 10)).toBe(false);
    expect(canRetake([], 10, 2, 10)).toBe(false);
    expect(retakesLeft([3], 2)).toBe(1);
  });
  it('builds capture plans and resumes from the first missing shot', () => {
    expect(capturePlan(10, 2)).toHaveLength(20);
    expect(capturePlan(10, 2, 4)).toEqual([
      { angle: 4, shot: 0 },
      { angle: 4, shot: 1 },
    ]);
    expect(nextMissingStep(photos.slice(0, 7), 10, 2)).toEqual({ angle: 3, shot: 1 });
    expect(nextMissingStep(photos, 10, 2)).toBeNull();
  });
});

describe('edit transforms', () => {
  it('toolbar ops match the prototype ed()', () => {
    let e = defaultEdit();
    e = applyEditOp(e, { op: 'rotate90' });
    expect(e.rotation).toBe(90);
    e = applyEditOp(applyEditOp(applyEditOp(e, { op: 'rotate90' }), { op: 'rotate90' }), { op: 'rotate90' });
    expect(e.rotation).toBe(0);
    expect(applyEditOp(e, { op: 'flip' }).flipHorizontal).toBe(true);
    let b = e;
    for (let i = 0; i < 20; i++) b = applyEditOp(b, { op: 'brightness', delta: 0.1 });
    expect(b.brightness).toBe(1.6);
    for (let i = 0; i < 20; i++) b = applyEditOp(b, { op: 'brightness', delta: -0.1 });
    expect(b.brightness).toBe(0.5);
    let c = e;
    const zooms = [1.25, 1.5, 1];
    for (const z of zooms) {
      c = applyEditOp(c, { op: 'crop' });
      expect(c.zoom).toBe(z);
    }
    expect(applyEditOp({ ...e, zoom: 3, x: 1 }, { op: 'reset' })).toEqual(defaultEdit());
  });
  it('gestures are normalized to the slot size and clamped', () => {
    const d = applyDrag(defaultEdit(), 50, -25, 200, 100);
    expect(d.x).toBeCloseTo(0.25);
    expect(d.y).toBeCloseTo(-0.25);
    const p = applyPinch(defaultEdit(), 10, 30, 0, 0, 200, 100);
    expect(p.zoom).toBe(4);
    expect(p.rotation).toBe(30);
    expect(applyPinch(defaultEdit(), 0.1, 0, 0, 0, 1, 1).zoom).toBe(0.6);
    expect(applyWheel(defaultEdit(), -200).zoom).toBeGreaterThan(1);
  });
  it('produces the same CSS transform order as the prototype', () => {
    const t = cssTransform({ ...defaultEdit(), x: 0.1, y: -0.2, rotation: 15, zoom: 1.5, flipHorizontal: true }, 200, 100);
    expect(t).toBe('translate(20.00px,-20.00px) rotate(15deg) scale(-1.5,1.5)');
  });
  it('computes the visible crop window', () => {
    expect(visibleCrop(defaultEdit())).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const v = visibleCrop({ ...defaultEdit(), zoom: 2 });
    expect(v).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });
});

describe('filters', () => {
  it('Original + brightness 1 is the identity', () => {
    expect(isIdentity(editColorMatrix(1, 'original'))).toBe(true);
  });
  it('Mono produces equal channels', () => {
    const [r, g, b] = applyColorMatrix(editColorMatrix(1, 'mono'), [0.8, 0.2, 0.4]);
    expect(r).toBeCloseTo(g, 5);
    expect(g).toBeCloseTo(b, 5);
  });
  it('Warm is warmer (more red than blue) on a neutral grey', () => {
    const [r, , b] = applyColorMatrix(editColorMatrix(1, 'warm'), [0.5, 0.5, 0.5]);
    expect(r).toBeGreaterThan(b);
  });
  it('brightness multiplies and composes in CSS order', () => {
    const [r] = applyColorMatrix(cssFilterToMatrix('brightness(1.2)'), [0.5, 0.5, 0.5]);
    expect(r).toBeCloseTo(0.6);
    const [c] = applyColorMatrix(cssFilterToMatrix('contrast(.5)'), [1, 1, 1]);
    expect(c).toBeCloseTo(0.75);
  });
});

describe('poses & config', () => {
  it('uses the prototype tips (10 angles × 2 shots)', () => {
    expect(tipFor(0, 0, 2)[3]).toBe('wave');
    expect(tipFor(9, 1, 2)).toEqual(TIPS[9][1]);
    expect(tipFor(12, 2, 3)[3]).toBeTruthy();
  });
  it('merges and validates admin overrides', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { pricing: { firstPrint: 70000 } });
    expect(s.pricing.firstPrint).toBe(70000);
    expect(s.pricing.additionalPrint).toBe(15000);
    expect(() => mergeSettings(DEFAULT_SETTINGS, { session: { angles: 0 } })).toThrow();
  });
});
