import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useBooth } from '../store';
import { cameraInstance } from '../camera/service';

const delay = (w: number) => `-${((Date.now() / 1000) % w).toFixed(2)}s`;

/**
 * prototype cam(): the camera container (corner frame, LIVE badge, countdown,
 * flash, status pill). Production: shows the REAL live view —
 *  - webcam: <video> from getUserMedia
 *  - DSLR via server driver: MJPEG <img>
 *  - mock camera: the prototype's animated gradient + silhouette placeholder
 * Fit (cover/contain), mirror and rotation come from configuration; the aspect
 * ratio is never distorted.
 */
export function Cam({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  const cfg = useBooth((s) => s.config?.camera);
  const camState = useBooth((s) => s.cameraState);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [delays] = useState(() => ({ d20: delay(20), d9: delay(9) }));

  const mode = cfg?.mode ?? 'mock';
  const live = mode === 'browser' ? ['ready', 'previewing', 'capturing'].includes(camState) : true;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (mode !== 'browser') return;
    const cam = cameraInstance();
    cam?.attachVideo(videoRef.current);
    void cam?.start().catch(() => undefined);
    return () => cam?.attachVideo(null);
  }, [mode]);

  const rot = cfg?.previewRotation ?? 0;
  const sideways = rot === 90 || rot === 270;
  const mediaStyle: CSSProperties = {
    transform: `${sideways ? 'translate(-50%,-50%) ' : ''}rotate(${rot}deg) scaleX(${cfg?.mirrorPreview ? -1 : 1})`,
    ...(sideways ? { left: '50%', top: '50%', width: box.h, height: box.w, inset: 'auto' } : {}),
  };
  const fit = cfg?.previewFit === 'contain' ? 'contain' : 'cover';

  return (
    <div className="cam" style={style} ref={boxRef}>
      {mode === 'browser' ? (
        // Always mounted: the stream is re-attached transparently after a reconnect.
        <video ref={videoRef} className={`lv ${fit}`} style={{ ...mediaStyle, visibility: live ? 'visible' : 'hidden' }} autoPlay muted playsInline />
      ) : mode === 'server' && cfg?.liveViewUrl ? (
        <img className={`lv ${fit}`} style={mediaStyle} src={cfg.liveViewUrl} alt="" draggable={false} />
      ) : null}
      {(mode === 'browser' && !live) || mode === 'mock' || (mode === 'server' && !cfg?.liveViewUrl) ? (
        <>
          <div className="b1" style={{ animationDelay: delays.d20 }} />
          <div className="b2" style={{ animationDelay: delays.d20 }} />
          <svg className="sil" viewBox="0 0 100 200" style={{ animationDelay: delays.d9 }}>
            <g opacity=".5" fill="#2B2A4C">
              <circle cx="50" cy="38" r="24" />
              <rect x="10" y="56" width="80" height="150" rx="40" />
            </g>
          </svg>
        </>
      ) : null}
      <div className="vf">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className={`live ${live ? '' : 'off'}`}>● LIVE</div>
      {children}
    </div>
  );
}
