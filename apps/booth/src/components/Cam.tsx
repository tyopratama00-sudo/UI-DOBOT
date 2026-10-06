import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useBooth } from '../store';
import { cameraInstance } from '../camera/service';
import { deviceKey } from '../kiosk';

/** Streams the server's multipart MJPEG live view into a canvas (reconnects on failure). */
function useMjpegCanvas(url: string | null | undefined, ref: { current: HTMLCanvasElement | null }) {
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    const dec = new TextDecoder();
    let drawing = false;
    const draw = (jpeg: Uint8Array<ArrayBuffer>) => {
      if (drawing) return; // drop frames while the previous one is still decoding
      drawing = true;
      createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
        .then((bmp) => {
          const c = ref.current;
          if (c) {
            if (c.width !== bmp.width || c.height !== bmp.height) Object.assign(c, { width: bmp.width, height: bmp.height });
            c.getContext('2d')?.drawImage(bmp, 0, 0);
          }
          bmp.close();
        })
        .catch(() => undefined)
        .finally(() => (drawing = false));
    };
    const headerEnd = (b: Uint8Array) => {
      for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
      return -1;
    };
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const key = deviceKey();
          const res = await fetch(url, { signal: ac.signal, cache: 'no-store', headers: key ? { 'x-booth-key': key } : {} });
          const reader = res.body!.getReader();
          let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const next = new Uint8Array(buf.length + value.length);
            next.set(buf);
            next.set(value, buf.length);
            buf = next;
            for (;;) {
              const h = headerEnd(buf);
              if (h < 0) break;
              const len = Number(/content-length:\s*(\d+)/i.exec(dec.decode(buf.subarray(0, h)))?.[1] ?? 0);
              if (buf.length < h + 4 + len) break;
              if (len) draw(buf.slice(h + 4, h + 4 + len));
              buf = buf.subarray(h + 4 + len);
            }
          }
        } catch {
          /* reconnect below */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => ac.abort();
  }, [url, ref]);
}

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
  const shotUrl = useBooth((s) => s.capture.shotUrl);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  useMjpegCanvas(mode === 'server' ? cfg?.liveViewUrl : null, canvasRef);

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
        // Canvas, not <img src=mjpeg>: Chrome leaves stale overlay pixels (countdown digits) on MJPEG images.
        // While the DSLR shoots no frames arrive, so the last frame simply stays.
        <canvas ref={canvasRef} className={`lv ${fit}`} style={mediaStyle} />
      ) : null}
      {shotUrl ? <img className={`lv ${fit}`} src={shotUrl} alt="" draggable={false} /> : null}
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
