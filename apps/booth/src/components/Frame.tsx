import { memo, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { computeFrameLayout, cssTransform, filterById, frameRadius, type EditParams, type PhotoDTO, type PhotoTemplate } from '@photobooth/shared';
import { Pic } from './basics';

/**
 * prototype frame(t, h, mode) — data driven. Geometry comes from the shared
 * `computeFrameLayout`, the same function the server renderer uses, so the
 * on-screen preview and the 300 DPI print are identical.
 *
 * mode 0: template preview · 1: live editor · 2: final (Ken Burns) · 3: pick · 4: QR (cycling)
 */
export interface FrameProps {
  t: PhotoTemplate;
  h: number;
  mode: 0 | 1 | 2 | 3 | 4;
  /** photo shown in each slot (undefined → empty numbered slot in mode 3) */
  slots: (PhotoDTO | undefined)[];
  edits?: Record<number, EditParams>;
  activeSlot?: number;
  /** all session photos (mode 4 cycling) */
  cycle?: PhotoDTO[];
  label: string;
  hiRes?: boolean;
  onSlotPointerDown?: (e: RPointerEvent<HTMLDivElement>, i: number) => void;
  onSlotWheel?: (e: RWheelEvent<HTMLDivElement>, i: number) => void;
}

export const Frame = memo(function Frame({ t, h, mode, slots, edits, activeSlot, cycle, label, hiRes, onSlotPointerDown, onSlotWheel }: FrameProps) {
  const L = computeFrameLayout(t, h);
  const live = mode === 1;
  const transformed = live || mode >= 2;
  const step = Math.max(1, Math.floor((cycle?.length ?? 20) / t.photoCount));
  const url = (p?: PhotoDTO) => (p ? (hiRes ? p.previewUrl : p.thumbUrl) : undefined);
  return (
    <div
      className="fr"
      data-avoid={live ? '' : undefined}
      style={{ width: L.width, height: L.height, background: t.background, padding: 0, display: 'block', borderRadius: frameRadius(h), flex: 'none' }}
    >
      {L.slots.map((r, i) => {
        const p = slots[i];
        const e = edits?.[i];
        const style = transformed && e ? { transform: cssTransform(e, r.w, r.h), filter: `brightness(${e.brightness}) ${filterById(e.filter).css}` } : {};
        return (
          <div
            key={i}
            className={`slot ${live && activeSlot === i ? 'on' : ''}`}
            data-testid={live ? `slot-${i}` : undefined}
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: r.w,
              height: r.h,
              borderRadius: L.slotRadius,
              boxShadow: L.ring ? `0 0 0 ${L.ring}px #fff,0 ${(8 * h) / 740}px ${(16 * h) / 740}px -${(8 * h) / 740}px rgba(43,42,76,.4)` : undefined,
            }}
            onPointerDown={live && onSlotPointerDown ? (ev) => onSlotPointerDown(ev, i) : undefined}
            onWheel={live && onSlotWheel ? (ev) => onSlotWheel(ev, i) : undefined}
          >
            {p ? (
              <Pic
                url={url(p)}
                className={mode === 2 ? 'kb' : ''}
                style={{ ...style, ...(mode === 2 ? { animationDelay: `-${(i * 1.7).toFixed(1)}s` } : {}) }}
              >
                {mode === 4 && cycle
                  ? cycle.map((cp, j) => (
                      <div key={cp.id} className="cyc" style={{ animationDelay: `${((j - i * step) * 2.4).toFixed(2)}s`, animationDuration: `${Math.max(20, cycle.length) * 2.4}s` }}>
                        <Pic url={cp.thumbUrl} />
                      </div>
                    ))
                  : null}
              </Pic>
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(255,255,255,.6)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: (40 * h) / 660,
                  color: '#7A7A9D',
                }}
              >
                {i + 1}
              </div>
            )}
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: L.label.x,
          top: L.label.y,
          width: L.label.w,
          height: L.label.h,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          fontWeight: 700,
          whiteSpace: 'nowrap',
          fontSize: L.label.fontSize,
          letterSpacing: '.16em',
          color: t.labelColor || '#2B2A4C',
          lineHeight: 1,
        }}
      >
        {label}
      </div>
    </div>
  );
});
