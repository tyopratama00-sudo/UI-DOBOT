import { useRef, useState } from 'react';
import { useBooth } from '../store';
import { Icon, Robot } from '../components/basics';
import { puffs } from '../robot/floating';
import { startSession } from '../flow';
import { requestFullscreen } from '../kiosk';

/** prototype V.welcome + ninja() */
export function Welcome() {
  const wr = useRef<HTMLDivElement>(null);
  const [vanish, setVanish] = useState(false);
  const branding = useBooth((s) => s.config?.branding);
  const angles = useBooth((s) => s.config?.session.angles ?? 10);
  const chip = (branding?.welcomeChip ?? 'Studio foto otomatis · 10 sudut').replace(/\b10 sudut\b/, `${angles} sudut`);

  const ninja = () => {
    if (vanish) return;
    void requestFullscreen();
    setVanish(true);
    puffs(wr.current, 620, 650, 9);
    setTimeout(() => puffs(wr.current, 620, 650, 6), 350);
    void startSession();
  };

  return (
    <div className="scr en" style={{ justifyContent: 'center', paddingLeft: 150 }}>
      <svg style={{ position: 'absolute', right: -140, top: 40 }} width="1000" height="1000" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="48" fill="var(--lv)" />
        <circle cx="50" cy="50" r="34" fill="var(--pk)" />
        <circle cx="50" cy="50" r="20" fill="var(--pe)" />
      </svg>
      <div id="wr" ref={wr} style={{ position: 'absolute', left: 1250, top: 225, width: 620, height: 650 }}>
        <div id="wri" className={vanish ? 'vanish' : ''}>
          <Robot m="hi" s={620} />
        </div>
      </div>
      <div style={{ position: 'relative', maxWidth: 1000 }}>
        <div className="chip b" style={{ marginBottom: 40 }}>
          {chip}
        </div>
        <h1>
          Robot
          <br />
          Photobooth
        </h1>
        <p className="p" style={{ fontSize: 48, margin: '34px 0 64px', lineHeight: 1.3 }}>
          Fotografer robotmu sudah siap.
          <br />
          Tinggal senyum.
        </p>
        <button className="btn pr" style={{ height: 150, padding: '0 100px', fontSize: 58 }} onClick={ninja} data-testid="start">
          <Icon n="cam" z={64} /> MULAI FOTO
        </button>
      </div>
    </div>
  );
}
