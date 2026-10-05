import { posedRobotSvg, robotSvg, GLYPHS } from '@photobooth/ui';
import type { BoothScreen } from '@photobooth/shared';

/**
 * The floating robot mascot (#rob) — a direct port of the prototype's
 * physics loop (F state, fl(), per(), react(), say(), rbNav(), burst(), puffs()).
 *
 * Production additions:
 *  - safe zones: idle targets avoid buttons / photos / the editor frame
 *  - taps on the robot that land over an interactive element are forwarded to it,
 *    so the mascot can never block the customer
 *  - screens where the robot must stay away (QR, payment, print) simply hide it
 */

export const FLY: BoothScreen[] = ['ready', 'session', 'review', 'tpl', 'pick', 'edit', 'final'];
const POOL = ['wave', 'grin', 'peace', 'cheer', 'thumbs', 'heart', 'free', 'hop', 'cool'];
const LINES: Partial<Record<BoothScreen, string>> = {
  ready: 'Siap difoto?',
  session: 'Senyum!',
  review: 'Fotomu bagus-bagus!',
  tpl: 'Frame yang cantik!',
  pick: 'Pilih yang kamu suka!',
  edit: 'Coba cubit fotonya!',
  final: 'Tinggal cetak!',
};
type Fx = 'heart' | 'star' | null | '' | undefined;
const RESP: { pose: string; an: string; t: () => string; fx?: Fx }[] = [
  { pose: 'cheer', an: 'spin', t: () => 'Wiii!', fx: 'star' },
  { pose: 'heart', an: 'wob', t: () => 'Makasih ya!', fx: 'heart' },
  { pose: 'shock', an: 'shake', t: () => 'Eh, kaget!' },
  { pose: 'thumbs', an: 'hop', t: () => LINES[robot.screen] || 'Mantap!' },
  { pose: 'free', an: 'dance', t: () => 'Ayo goyang!', fx: 'star' },
  { pose: 'peace', an: 'wob', t: () => 'Cekrek! Peace!' },
];

const INTERACTIVE = 'button,.btn,.th,[data-tap],.slot,input';

class FloatingRobot {
  screen: BoothScreen = 'welcome';
  private rob: HTMLDivElement | null = null;
  private rbi: HTMLDivElement | null = null;
  private rbb: HTMLDivElement | null = null;
  private stage: HTMLElement | null = null;
  private raf = 0;
  private bt: ReturnType<typeof setTimeout> | undefined;
  private to: ReturnType<typeof setTimeout> | undefined;
  private F = {
    x: 500, y: 300, vx: 0, vy: 0, tx: 900, ty: 500, t: 0, pause: 0, pose: '', sz: 0, n: 0, on: false, l: 0,
    u: 0, dir: 1, dash: 0, busy: 0, edge: 0,
  };
  private sessionPose = 'grin';

  attach(rob: HTMLDivElement, rbi: HTMLDivElement, rbb: HTMLDivElement, stage: HTMLElement) {
    this.rob = rob;
    this.rbi = rbi;
    this.rbb = rbb;
    this.stage = stage;
    rbi.addEventListener('pointerdown', this.onTap);
    this.raf = requestAnimationFrame(this.fl);
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.rbi?.removeEventListener('pointerdown', this.onTap);
    this.rob = this.rbi = this.rbb = this.stage = null;
  }

  get busy() {
    return !!this.F.busy;
  }

  // -------------------------------------------------------------- prototype API

  setPose(k: string, sz: number) {
    const F = this.F;
    if (!this.rob || !this.rbi) return;
    if (k == F.pose && sz == F.sz) return;
    F.pose = k;
    F.sz = sz;
    this.rob.style.width = sz + 'px';
    this.rob.style.height = sz * 1.05 + 'px';
    this.rbi.innerHTML = k == 'cam' ? robotSvg('cam', sz) : posedRobotSvg(k, sz);
  }

  /** prototype syncRob(): called whenever the screen or the session phase changes */
  sync(screen: BoothScreen, sessionPose?: string) {
    const F = this.F;
    this.screen = screen;
    if (sessionPose) this.sessionPose = sessionPose;
    F.on = FLY.includes(screen);
    if (!this.rob) return;
    this.rob.style.display = F.on ? 'block' : 'none';
    if (!F.on) return;
    const sz = screen == 'ready' || screen == 'session' ? 300 : 220;
    this.setPose(screen == 'ready' ? 'wave' : screen == 'session' ? this.sessionPose : F.pose && F.pose != 'cam' ? F.pose : 'grin', sz);
    const eg = screen == 'session' || screen == 'ready';
    if (eg && !F.edge) {
      F.edge = 1;
      if (F.x > 300 && F.x < 1300 && F.y > 150 && F.y < 700) {
        F.x = -380;
        F.vx = 1200;
        F.y = 300;
      }
      F.t = 0;
    }
    if (!eg) F.edge = 0;
  }

  private nextPose() {
    if (this.screen == 'session' || this.screen == 'ready') return;
    this.setPose(POOL[Math.floor(Math.random() * POOL.length)], 220);
  }

  burst(k: 'heart' | 'star') {
    if (!this.rob) return;
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div');
      d.className = 'pt';
      d.style.setProperty('--dx', Math.random() * 300 - 150 + 'px');
      d.style.setProperty('--dy', -60 - Math.random() * 160 + 'px');
      d.innerHTML = `<svg width="40" height="40" viewBox="-14 -14 28 28">${GLYPHS[k]}</svg>`;
      this.rob.appendChild(d);
      setTimeout(() => d.remove(), 1500);
    }
  }

  say(t: string, ms = 1800) {
    if (!this.rbb) return;
    this.rbb.textContent = t;
    this.rbb.className = 'on' + (this.F.y < 150 ? ' bl' : '');
    clearTimeout(this.bt);
    this.bt = setTimeout(() => this.rbb && (this.rbb.className = ''), ms);
  }

  react(pose: string, an: string | null, t: string, fx?: Fx, pause = 1.6) {
    const F = this.F;
    if (!F.on || !this.rbi) return;
    this.setPose(pose, F.sz);
    F.pause = pause;
    this.rbi.className = '';
    void this.rbi.offsetWidth;
    this.rbi.className = an ? 'ra-' + an : '';
    this.say(t, pause * 1000 + 200);
    if (fx) this.burst(fx);
    clearTimeout(this.to);
    this.to = setTimeout(() => {
      if (this.rbi) this.rbi.className = '';
      F.t = 0;
    }, pause * 1000);
  }

  /** prototype rbNav(): robot dashes off screen, then navigation happens. */
  rbNav(msg: string, pose: string, fn: () => void) {
    const F = this.F;
    if (F.busy) return;
    if (!F.on || !this.rbi) {
      fn();
      return;
    }
    F.busy = 1;
    this.setPose(pose, F.sz);
    this.rbi.className = '';
    F.pause = 0;
    this.say(msg, 800);
    F.dash = 1;
    setTimeout(() => {
      try {
        fn();
      } finally {
        F.dash = 0;
        F.x = -380;
        F.vx = 1500;
        F.vy = 0;
        F.y = 250 + Math.random() * 350;
        F.t = 0;
        F.busy = 0;
      }
    }, 780);
  }

  // -------------------------------------------------------------- taps

  private onTap = (ev: PointerEvent) => {
    // Never block the customer: forward taps that land over a control.
    const under = this.elementUnder(ev.clientX, ev.clientY);
    const target = under?.closest(INTERACTIVE) as HTMLElement | null;
    if (target && this.stage?.contains(target)) {
      ev.preventDefault();
      ev.stopPropagation();
      if (target.classList.contains('slot')) {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ev.clientX, clientY: ev.clientY, pointerId: ev.pointerId, pointerType: ev.pointerType, isPrimary: ev.isPrimary }));
      } else target.click();
      return;
    }
    const r = RESP[this.F.n++ % RESP.length];
    this.react(r.pose, r.an, r.t(), r.fx, 1.9);
  };

  private elementUnder(x: number, y: number): HTMLElement | null {
    if (!this.rob) return null;
    const prev = this.rob.style.visibility;
    this.rob.style.visibility = 'hidden';
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    this.rob.style.visibility = prev;
    return el;
  }

  // -------------------------------------------------------------- movement

  private per(u: number): [number, number] {
    const F = this.F;
    const X0 = 8, X1 = 1920 - F.sz - 8, Y0 = 70, Y1 = 1080 - F.sz - 30, W = X1 - X0, H = Y1 - Y0;
    let d = u * 2 * (W + H);
    if (d < W) return [X0 + d, Y0];
    d -= W;
    if (d < H) return [X1, Y0 + d];
    d -= H;
    if (d < W) return [X1 - d, Y1];
    d -= W;
    return [X0, Y1 - d];
  }

  /** Stage-space rectangles the robot should not park on (safe zones). */
  private avoidRects(): { x: number; y: number; w: number; h: number }[] {
    if (!this.stage) return [];
    const sr = this.stage.getBoundingClientRect();
    const k = sr.width / 1920 || 1;
    const out: { x: number; y: number; w: number; h: number }[] = [];
    this.stage.querySelectorAll<HTMLElement>(`${INTERACTIVE},[data-avoid]`).forEach((el) => {
      if (this.rob?.contains(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      out.push({ x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k });
    });
    return out;
  }

  private pickTarget(): [number, number] {
    const F = this.F;
    const avoid = this.avoidRects();
    let best: [number, number] = [40 + Math.random() * (1920 - F.sz - 80), 90 + Math.random() * (1080 - F.sz - 150)];
    let bestScore = Infinity;
    for (let i = 0; i < 28; i++) {
      const x = 40 + Math.random() * (1920 - F.sz - 80);
      const y = 90 + Math.random() * (1080 - F.sz - 150);
      let s = 0;
      for (const r of avoid) {
        const ox = Math.max(0, Math.min(x + F.sz, r.x + r.w) - Math.max(x, r.x));
        const oy = Math.max(0, Math.min(y + F.sz * 1.05, r.y + r.h) - Math.max(y, r.y));
        s += ox * oy;
      }
      if (s < bestScore) {
        bestScore = s;
        best = [x, y];
        if (s === 0) break;
      }
    }
    return best;
  }

  private fl = (ts: number) => {
    this.raf = requestAnimationFrame(this.fl);
    const F = this.F;
    if (!F.on || !this.rob) return;
    const dt = Math.min(0.05, (ts - (F.l || ts)) / 1000);
    F.l = ts;
    if (F.dash == 1) {
      F.x += 2600 * dt;
    } else {
      if (F.pause > 0) {
        F.pause -= dt;
        F.vx *= 0.9;
        F.vy *= 0.9;
      } else {
        F.t -= dt;
        if (F.t <= 0) {
          F.t = 2.4 + Math.random() * 2.2;
          if (this.screen == 'session' || this.screen == 'ready') {
            F.u = (F.u + F.dir * (0.05 + Math.random() * 0.08) + 1) % 1;
            if (Math.random() < 0.2) F.dir *= -1;
            const q = this.per(F.u);
            F.tx = q[0];
            F.ty = q[1];
          } else {
            const q = this.pickTarget();
            F.tx = q[0];
            F.ty = q[1];
            this.nextPose();
          }
        }
        const ax = (F.tx - F.x) * 1.5 - F.vx * 2.1;
        const ay = (F.ty - F.y) * 1.5 - F.vy * 2.1;
        F.vx += ax * dt;
        F.vy += ay * dt;
      }
      F.x += F.vx * dt;
      F.y += F.vy * dt;
    }
    this.rob.style.transform = `translate3d(${F.x.toFixed(1)}px,${(F.y + Math.sin(ts / 520) * 10).toFixed(1)}px,0) rotate(${Math.max(-10, Math.min(10, F.vx / 45)).toFixed(1)}deg)`;
  };
}

export const robot = new FloatingRobot();

/** prototype puffs(): ninja smoke puffs inside a box */
export function puffs(box: HTMLElement | null, w: number, h: number, n: number) {
  if (!box) return;
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    const z = 130 + (Math.random() * 130 * w) / 300;
    d.className = 'puff';
    d.style.cssText = `width:${z}px;height:${z}px;left:${w * (0.1 + Math.random() * 0.8) - z / 2}px;top:${h * (0.15 + Math.random() * 0.7) - z / 2}px;--dx:${Math.random() * 140 - 70}px;--dy:${-30 - Math.random() * 110}px;animation-delay:${(Math.random() * 0.3).toFixed(2)}s`;
    box.appendChild(d);
    setTimeout(() => d.remove(), 1900);
  }
}
