import { nextMissingStep, p2, POSE_NAMES, tipFor } from '@photobooth/shared';
import { useBooth } from '../store';
import { Cam, } from '../components/Cam';
import { Icon } from '../components/basics';
import { skipSession } from '../flow';

/** prototype V.ready */
export function Ready() {
  const cd = useBooth((s) => s.readyCd);
  const session = useBooth((s) => s.session)!;
  const total = session.plan.readySeconds || 5;
  const next = nextMissingStep(session.photos, session.plan.angles, session.plan.shotsPerAngle);
  const angle = next?.angle ?? 0;
  const pct = total > 1 ? ((total - cd) / (total - 1)) * 100 : 100;
  return (
    <div className="scr en">
      <div className="top">
        <div className="chip b">Sudut {p2(angle + 1)} segera dimulai</div>
        <div className="chip y" data-testid="ready-cd">
          Mulai dalam {cd} detik
        </div>
      </div>
      <Cam style={{ flex: 1 }}>
        <div className="stat">
          Cari posisimu dan duduk yang nyaman
          <small>Kamu boleh bergerak bebas. Robot yang menyesuaikan.</small>
        </div>
      </Cam>
      <div className="bar" style={{ marginTop: 24 }}>
        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

/** Pose shown by the floating robot during the session (prototype sesPose()). */
export function sessionPose(phase: string, angle: number, shot: number, shotsPerAngle: number): string {
  if (phase === 'move') return 'cam';
  if (phase === 'nice') return 'cheer';
  if (phase === 'retry') return 'think';
  return tipFor(angle, Math.max(shot, 1) - 1, shotsPerAngle)[3];
}

/** prototype V.session */
export function Session() {
  const session = useBooth((s) => s.session)!;
  const c = useBooth((s) => s.capture);
  const { angles, shotsPerAngle } = session.plan;
  const retake = session.status === 'RETAKE' || session.capture.retakeAngle !== null;
  const a = c.angle;
  const tip = tipFor(a, Math.max(c.shot, 1) - 1, shotsPerAngle);
  const m: [string, string] =
    ({
      move: [`Pindah ke Sudut ${p2(a + 1)}…`, 'Robot sedang mencari angle terbaik.'],
      prep: [POSE_NAMES[tip[3]] ?? tip[1], `${tip[1]} · ${tip[2]}`],
      cd: [POSE_NAMES[tip[3]] ?? tip[1], ''],
      nice: [c.message, ''],
      retry: [c.message, ''],
    } as Record<string, [string, string]>)[c.phase] ?? ['', ''];
  const totalPhotos = session.photos.length;
  return (
    <div className="scr en">
      <div className="top">
        <div className="chip b" data-testid="session-angle">
          {retake ? 'ULANG · ' : ''}SUDUT {p2(a + 1)} / {p2(angles)}
        </div>
        <div className="dots">
          {[...Array(angles)].map((_, i) => (
            <i key={i} className={i < a ? 'on' : i == a ? 'cur' : ''} />
          ))}
        </div>
        <div className="chip">
          FOTO {p2(Math.max(c.shot, 1))} / {p2(shotsPerAngle)}
        </div>
      </div>
      <Cam style={{ flex: 1, position: 'relative' }}>
        <div className={`cd ${c.phase === 'cd' && c.cd ? 'pop' : ''}`} key={`cd${c.cdKey ?? 0}`} id="cd">
          {c.phase === 'cd' && c.cd ? c.cd === 'cam' ? <Icon n="cam" z={240} c="#fff" /> : c.cd : null}
        </div>
        <div className={`fl ${c.flashKey ? 'go' : ''}`} key={`fl${c.flashKey ?? 0}`} id="fl" />
        {m[0] ? (
          <div className="stat tip" key={`${c.phase}${c.shot}${a}`} data-testid="session-stat">
            {m[0]}
            {m[1] ? <small>{m[1]}</small> : null}
          </div>
        ) : null}
      </Cam>
      {a < angles - 1 && totalPhotos >= 3 ? (
        <div style={{ position: 'absolute', right: 32, bottom: 32, zIndex: 10 }}>
          <button className="btn" style={{ height: 72, fontSize: 32, background: 'var(--mi)', color: 'var(--ink)', padding: '0 36px' }} onClick={skipSession}>
            SELESAI
          </button>
        </div>
      ) : null}
    </div>
  );
}
