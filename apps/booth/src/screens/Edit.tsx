import { useCallback, useEffect, useRef, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { applyDrag, applyPinch, applyWheel, cssTransform, defaultEdit, FILTERS, filterById, type EditParams } from '@photobooth/shared';
import { computeFrameLayout } from '@photobooth/shared';
import { currentTemplate, get, useBooth, useFlatPhotos } from '../store';
import { Frame } from '../components/Frame';
import { Icon, Pic } from '../components/basics';
import { back, editDone, editOf, editOp, selectSlot, setEdit } from '../flow';
import type { IconName } from '@photobooth/ui';

const FRAME_H = 740;

/**
 * prototype V.edit + touch gestures:
 * 1 finger drag, 2 fingers pinch-zoom + twist, double tap reset, mouse wheel zoom.
 * Edits are non-destructive parameters; the server renders them at print resolution.
 */
export function Edit() {
  const t = useBooth(currentTemplate);
  const picks = useBooth((s) => s.picks);
  const photos = useBooth((s) => s.session!.photos);
  const edits = useBooth((s) => s.edits);
  const slot = useBooth((s) => s.slot);
  const label = useBooth((s) => s.config!.branding.label);
  const busy = useBooth((s) => s.busy);
  const flat = useFlatPhotos();
  const n = t.photoCount;
  const slots = [...Array(n)].map((_, i) => photos.find((p) => p.id === picks[i]));
  const e = edits[slot] ?? defaultEdit();
  const current = slots[slot] ?? flat[0];
  const layout = computeFrameLayout(t, FRAME_H);
  const frameRef = useRef<HTMLDivElement>(null);

  // ---- gestures (port of prototype pd/pm/pu with normalized coordinates)
  const PT = useRef(new Map<number, { x: number; y: number }>());
  const base = useRef<{ e: EditParams; p: { x: number; y: number }[]; k: number; d?: number; a?: number; slot: number } | null>(null);
  const dtap = useRef(0);
  const live = useRef<EditParams | null>(null);

  const stageScale = () => {
    const st = document.getElementById('st');
    return st ? st.getBoundingClientRect().width / 1920 : 1;
  };

  const snap = (i: number) => {
    const p = [...PT.current.values()];
    const b: NonNullable<typeof base.current> = { e: { ...(live.current ?? editOf(i)) }, p: p.map((q) => ({ ...q })), k: stageScale(), slot: i };
    if (p.length > 1) {
      b.d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      b.a = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
    }
    base.current = b;
  };

  const paint = (i: number, ed: EditParams) => {
    const el = frameRef.current?.querySelectorAll<HTMLElement>('.slot')[i]?.querySelector<HTMLElement>('.ph');
    const r = layout.slots[i];
    if (el && r) {
      el.style.transform = cssTransform(ed, r.w, r.h);
      el.style.filter = `brightness(${ed.brightness}) ${filterById(ed.filter).css}`;
    }
  };

  const onMove = useCallback((ev: PointerEvent) => {
    if (!PT.current.has(ev.pointerId) || !base.current) return;
    PT.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const b = base.current;
    const p = [...PT.current.values()];
    const r = layout.slots[b.slot];
    let ed = b.e;
    if (p.length == 1) ed = applyDrag(b.e, (p[0].x - b.p[0].x) / b.k, (p[0].y - b.p[0].y) / b.k, r.w, r.h);
    else if (b.d && b.p.length > 1) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      const a = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      ed = applyPinch(
        b.e,
        d / b.d,
        ((a - (b.a ?? 0)) * 180) / Math.PI,
        (p[0].x + p[1].x - (b.p[0].x + b.p[1].x)) / 2 / b.k,
        (p[0].y + p[1].y - (b.p[0].y + b.p[1].y)) / 2 / b.k,
        r.w,
        r.h,
      );
    }
    live.current = ed;
    paint(b.slot, ed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id]);

  const onUp = useCallback((ev: PointerEvent) => {
    PT.current.delete(ev.pointerId);
    const b = base.current;
    if (PT.current.size && b) {
      snap(b.slot);
      return;
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (b && live.current) setEdit(b.slot, live.current);
    live.current = null;
    base.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMove]);

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    },
    [onMove, onUp],
  );

  const onDown = (ev: RPointerEvent<HTMLDivElement>, i: number) => {
    ev.preventDefault();
    if (get().slot !== i) selectSlot(i);
    PT.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const now = Date.now();
    if (PT.current.size == 1 && now - dtap.current < 320) {
      dtap.current = 0;
      PT.current.clear();
      live.current = null;
      base.current = null;
      setEdit(i, defaultEdit());
      return;
    }
    if (PT.current.size == 1) dtap.current = now;
    snap(i);
    if (PT.current.size === 1) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
  };

  const onWheel = (ev: RWheelEvent<HTMLDivElement>, i: number) => {
    if (get().slot !== i) selectSlot(i);
    setEdit(i, applyWheel(editOf(i), ev.deltaY));
  };

  const T = (i: IconName, l: string, a: () => void, id: string) => (
    <button className="btn tool" onClick={a} data-testid={`tool-${id}`}>
      <span>
        <Icon n={i} z={46} />
      </span>
      {l}
    </button>
  );
  const g = (i: IconName, l: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 48 }}>
        <Icon n={i} z={48} />
      </div>
      {l}
    </div>
  );

  return (
    <div className="scr en">
      <div className="top">
        <button className={`btn sm ${busy === 'back' ? 'wait' : ''}`} onClick={back}>
          <Icon n="back" z={30} />
          Foto
        </button>
        <div className="chip b" data-testid="edit-chip">
          Sedang mengedit foto {slot + 1} dari {n}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'center', alignItems: 'center', gap: 64 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }} ref={frameRef}>
          <Frame t={t} h={FRAME_H} mode={1} slots={slots} edits={edits} activeSlot={slot} label={t.label || label} hiRes onSlotPointerDown={onDown} onSlotWheel={onWheel} />
          <div className="p" style={{ fontSize: 26 }}>
            Ketuk foto di frame untuk memilih
          </div>
        </div>
        <div style={{ width: 660, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card" style={{ padding: '22px 14px', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
            {g('drag', 'Geser foto')}
            {g('pinch', 'Cubit untuk zoom')}
            {g('twist', 'Putar 2 jari')}
            {g('tap', 'Ketuk 2× reset')}
          </div>
          <div className="card" style={{ padding: 18, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 12 }}>
            {FILTERS.map((f) => (
              <div key={f.id} onClick={() => editOp({ op: 'filter', filter: f.id })} style={{ textAlign: 'center', fontSize: 24, fontWeight: 600 }} data-testid={`filter-${f.id}`}>
                <div className={`th ${e.filter == f.id ? 'sel' : ''}`} style={{ aspectRatio: '1', borderRadius: 20, marginBottom: 6 }}>
                  <Pic url={current?.thumbUrl} style={{ filter: f.css }} />
                </div>
                {f.label}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
            {T('flip', 'Balik', () => editOp({ op: 'flip' }), 'flip')}
            {T('rot', 'Putar 90°', () => editOp({ op: 'rotate90' }), 'rotate')}
            {T('crop', 'Potong', () => editOp({ op: 'crop' }), 'crop')}
            {T('sun', 'Terang +', () => editOp({ op: 'brightness', delta: 0.1 }), 'bright-up')}
            {T('moon', 'Terang −', () => editOp({ op: 'brightness', delta: -0.1 }), 'bright-down')}
            {T('reset', 'Reset', () => editOp({ op: 'reset' }), 'reset')}
          </div>
          <button className={`btn pr ${busy === 'edit_done' ? 'wait' : ''}`} style={{ height: 112 }} onClick={editDone} data-testid="edit-done">
            SELESAI <Icon n="next" z={36} />
          </button>
        </div>
      </div>
    </div>
  );
}
