/**
 * Robot mascot SVG generators — a faithful TypeScript port of the prototype's
 * `R()` (classic robot with simple moods) and `RP()` (posable robot with 20+
 * poses, expressions, arm positions and accessories).
 *
 * They return SVG markup strings (exactly the same markup as the prototype) so
 * they can be used by React (dangerouslySetInnerHTML), by the server-side gallery
 * page and by the maintenance screen without any visual drift.
 */

export interface PoseDef {
  /** left hand position */
  L?: [number, number];
  /** right hand position */
  R?: [number, number];
  /** right arm curve control point */
  rc?: [number, number];
  /** wave the raised hand(s) */
  hl?: 1;
  /** accessory: th=thumb, v=peace, hr=hearts, sp=sparkles */
  x?: 'th' | 'v' | 'hr' | 'sp';
  /** eyes */
  e?: 'o' | 'happy' | 'wide' | 'wink' | 'ser' | 'cool';
  /** mouth */
  m?: 'smile' | 'grin' | 'O' | 'pout' | 'flat';
  /** head tilt (deg) */
  t?: number;
  /** body lean (deg) */
  b?: number;
  /** idle animation */
  an?: 'bob' | 'sway' | 'pop' | 'rock' | 'hop' | 'dance' | 'poke' | '';
}

export const POSES: Record<string, PoseDef> = {
  wave: { R: [192, 104], hl: 1, e: 'o', m: 'smile', an: 'sway' },
  grin: { e: 'happy', m: 'grin', an: 'bob' },
  peace: { R: [172, 112], x: 'v', e: 'happy', m: 'smile', t: -6, an: 'sway' },
  lean: { t: 14, b: 5, e: 'o', m: 'smile', an: 'sway' },
  shock: { L: [52, 120], R: [168, 120], e: 'wide', m: 'O', an: 'pop' },
  cheek: { R: [160, 126], e: 'happy', m: 'smile', t: -8, an: 'sway' },
  cool: { L: [112, 178], R: [108, 178], e: 'cool', m: 'flat', t: -4, an: 'bob' },
  thumbs: { L: [38, 130], R: [182, 130], x: 'th', e: 'happy', m: 'grin', an: 'bob' },
  hug: { R: [200, 180], t: 12, b: 6, e: 'happy', m: 'smile', an: 'sway' },
  laugh: { L: [98, 184], R: [122, 184], e: 'happy', m: 'grin', an: 'rock' },
  model: { R: [130, 194], rc: [190, 172], t: -6, b: 5, e: 'o', m: 'smile', an: 'sway' },
  pout: { e: 'wide', m: 'pout', t: 8, an: 'sway' },
  heart: { L: [48, 88], R: [172, 88], x: 'hr', e: 'happy', m: 'smile', an: 'bob' },
  peek: { R: [158, 100], e: 'wink', m: 'smile', t: -10, an: 'sway' },
  point: { R: [206, 150], e: 'wink', m: 'grin', an: 'poke' },
  serious: { L: [112, 178], R: [108, 178], e: 'ser', m: 'flat' },
  arms: { L: [54, 64], R: [166, 64], e: 'happy', m: 'grin', an: 'hop' },
  hop: { L: [34, 150], R: [186, 150], e: 'happy', m: 'grin', an: 'hop' },
  fav: { R: [186, 144], x: 'th', e: 'happy', m: 'grin', an: 'sway' },
  free: { L: [42, 120], R: [178, 120], x: 'sp', hl: 1, e: 'happy', m: 'grin', an: 'dance' },
  cheer: { L: [54, 64], R: [166, 64], e: 'happy', m: 'grin', an: 'hop' },
};

/** Idle animation periods (seconds) — used to phase-sync animations across re-renders. */
const AP: Record<string, number> = { bob: 1.4, sway: 2.4, pop: 2, rock: 0.7, hop: 1.1, dance: 1.2 };

const dl = (w: number) => `animation-delay:-${((Date.now() / 1000) % w).toFixed(2)}s`;

/** Posable robot (prototype RP). */
export function posedRobotSvg(k: string, z = 250): string {
  const q = POSES[k] || {};
  const p = { e: 'o', m: 'smile', t: 0, b: 0, an: '', ...q } as Required<Pick<PoseDef, 'e' | 'm' | 't' | 'b' | 'an'>> & PoseDef;
  const C = '#5EE0FF';
  const EY = {
    o: `<circle cx="88" cy="88" r="9" fill="${C}"/><circle cx="132" cy="88" r="9" fill="${C}"/>`,
    happy: `<path d="M78 92q10-16 20 0M122 92q10-16 20 0" stroke="${C}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
    wide: `<circle cx="88" cy="88" r="13" fill="${C}"/><circle cx="132" cy="88" r="13" fill="${C}"/>`,
    wink: `<circle cx="88" cy="88" r="9" fill="${C}"/><path d="M122 92q10-16 20 0" stroke="${C}" stroke-width="7" fill="none" stroke-linecap="round"/>`,
    ser: `<circle cx="88" cy="90" r="7" fill="${C}"/><circle cx="132" cy="90" r="7" fill="${C}"/><path d="M76 76l24 8M144 76l-24 8" stroke="${C}" stroke-width="6" stroke-linecap="round"/>`,
    cool: `<rect x="70" y="78" width="80" height="22" rx="11" fill="#E9FBFF"/><rect x="78" y="83" width="20" height="6" rx="3" fill="#fff"/>`,
  }[p.e];
  const MO = {
    smile: `<path d="M96 108q14 12 28 0" stroke="${C}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    grin: `<path d="M92 104h36a18 16 0 01-36 0z" fill="${C}"/>`,
    O: `<ellipse cx="110" cy="112" rx="7" ry="9" fill="none" stroke="${C}" stroke-width="5"/>`,
    pout: `<circle cx="110" cy="111" r="5" fill="${C}"/>`,
    flat: `<path d="M98 111h24" stroke="${C}" stroke-width="5" stroke-linecap="round"/>`,
  }[p.m];
  const ex = (H: [number, number], r: number) =>
    p.x == 'th'
      ? `<path d="M${H[0]} ${H[1] - 6}v-20" stroke="#FFD166" stroke-width="10" stroke-linecap="round"/>`
      : p.x == 'v' && r
        ? `<path d="M${H[0] - 4} ${H[1] - 8}l-6-22M${H[0] + 6} ${H[1] - 8}l6-22" stroke="#FFD166" stroke-width="7" stroke-linecap="round"/>`
        : '';
  const arm = (sx: number, H: [number, number], cls: string, rc: [number, number] | null | undefined, cu: boolean, r: number) => {
    const c = rc || [(sx + H[0]) / 2 + (sx < 110 ? -18 : 18), (165 + H[1]) / 2 + 16];
    const style = cls == 'wave' || cls == 'wavel' ? `style="${dl(1.4)}"` : cls == 'poke' ? `style="${dl(1.2)}"` : '';
    return `<g class="${cls}" ${style}><circle cx="${sx}" cy="165" r="11" fill="#7FD6F0"/><path d="M${sx} 165Q${c[0]} ${c[1]} ${H[0]} ${H[1]}" stroke="#7FD6F0" stroke-width="14" stroke-linecap="round" fill="none"/><circle cx="${H[0]}" cy="${H[1]}" r="11" fill="#FFD166"/>${cu ? ex(H, r) : ''}</g>`;
  };
  const hp = (x: number, y: number, c: string) =>
    `<g class="flt" style="${dl(2.6)}"><path transform="translate(${x} ${y}) scale(1.5)" d="M0 8C-14 -2 -8 -14 0 -6C8 -14 14 -2 0 8z" fill="${c}"/></g>`;
  const sp = (x: number, y: number) =>
    `<g class="flt" style="${dl(2.6)}"><path d="M${x} ${y - 12}v24M${x - 12} ${y}h24" stroke="#B79CFF" stroke-width="6" stroke-linecap="round"/></g>`;
  const X = p.x == 'hr' ? hp(198, 42, '#FF9EC4') + hp(24, 56, '#FFB8D6') : p.x == 'sp' ? sp(200, 40) + sp(24, 54) : '';
  const leftArm = arm(74, q.L || [42, 196], q.hl && q.L ? 'wavel' : '', null, !!q.L, 0);
  const rightArm = arm(146, q.R || [178, 196], q.hl && q.R ? 'wave' : p.an == 'poke' ? 'poke' : '', q.rc, !!q.R, 1);
  return `<svg class="rb" viewBox="0 0 230 240" width="${z}" height="${(z * 240) / 230}"><ellipse cx="110" cy="230" rx="54" ry="8" fill="#2B2A4C" opacity=".08"/><g transform="rotate(${p.b} 110 228)"><g class="an-${p.an}" style="${p.an && AP[p.an] ? dl(AP[p.an]) : ''}"><g transform="rotate(${p.t} 110 140)"><path d="M110 50V26" stroke="#7FD6F0" stroke-width="6" stroke-linecap="round"/><circle cx="110" cy="18" r="10" fill="#FFD166"/><rect x="50" y="46" width="120" height="94" rx="38" fill="#fff" stroke="#BFEAF7" stroke-width="5"/><rect x="64" y="62" width="92" height="62" rx="28" fill="#2B2A4C"/>${EY}${MO}<circle cx="72" cy="112" r="6" fill="#FF9EC4" opacity=".8"/><circle cx="148" cy="112" r="6" fill="#FF9EC4" opacity=".8"/></g><rect x="72" y="148" width="76" height="62" rx="28" fill="#fff" stroke="#BFEAF7" stroke-width="5"/><circle cx="110" cy="178" r="13" fill="#7FD6F0"/><circle cx="110" cy="178" r="5" fill="#fff"/>${leftArm}${rightArm}${X}</g></g></svg>`;
}

export type RobotMood = 'hi' | 'happy' | 'think' | 'cheer' | 'thumb' | 'point' | 'cam';

/** Classic robot with moods (prototype R). */
export function robotSvg(m: RobotMood = 'hi', s = 240): string {
  const eyesKey = m == 'cheer' || m == 'thumb' ? 'happy' : m == 'think' ? 'think' : 'hi';
  const e = {
    hi: '<circle cx="88" cy="94" r="9" fill="#5EE0FF"/><circle cx="132" cy="94" r="9" fill="#5EE0FF"/>',
    happy: '<path d="M78 98q10-16 20 0M122 98q10-16 20 0" stroke="#5EE0FF" stroke-width="7" fill="none" stroke-linecap="round"/>',
    think: '<circle cx="92" cy="86" r="9" fill="#5EE0FF"/><circle cx="136" cy="86" r="6" fill="#5EE0FF"/><path d="M100 110h22" stroke="#5EE0FF" stroke-width="5" stroke-linecap="round"/>',
  }[eyesKey];
  const A =
    ({
      hi: `<path class="wave" style="animation-delay:-${((Date.now() / 1000) % 1.4).toFixed(2)}s" d="M146 165L186 118" />`,
      point: '<path d="M146 165L196 158"/>',
      cheer: '<path d="M146 165L184 112M74 165L36 112"/>',
      think: '<path d="M146 165L128 128"/>',
      cam: '<path d="M146 165L150 192M74 165L70 192"/>',
      thumb: '<path d="M146 165L184 140"/>',
    } as Record<string, string>)[m] || '<path d="M146 165L186 118"/>';
  const L = ['cheer', 'cam'].includes(m) ? '' : '<path d="M74 165L40 188"/>';
  const cls = m == 'cheer' ? 'jump' : 'float';
  const delay = ((Date.now() / 1000) % (m == 'cheer' ? 1 : 3)).toFixed(2);
  return `<svg class="rb ${cls}" style="animation-delay:-${delay}s" viewBox="0 0 230 240" width="${s}" height="${(s * 240) / 230}"><ellipse cx="110" cy="230" rx="54" ry="8" fill="#2B2A4C" opacity=".08"/><path d="M110 50V26" stroke="#7FD6F0" stroke-width="6" stroke-linecap="round"/><circle cx="110" cy="18" r="10" fill="#FFD166"/><rect x="50" y="46" width="120" height="94" rx="38" fill="#fff" stroke="#BFEAF7" stroke-width="5"/><rect x="64" y="62" width="92" height="62" rx="28" fill="#2B2A4C"/>${e}${m == 'think' ? '' : '<path d="M98 111q12 10 24 0" stroke="#5EE0FF" stroke-width="5" fill="none" stroke-linecap="round"/>'}<circle cx="72" cy="112" r="6" fill="#FF9EC4" opacity=".8"/><circle cx="148" cy="112" r="6" fill="#FF9EC4" opacity=".8"/><rect x="72" y="148" width="76" height="62" rx="28" fill="#fff" stroke="#BFEAF7" stroke-width="5"/><circle cx="110" cy="178" r="13" fill="#7FD6F0"/><circle cx="110" cy="178" r="5" fill="#fff"/><g stroke="#7FD6F0" stroke-width="14" stroke-linecap="round" fill="none">${A}${L}</g><circle cx="74" cy="165" r="11" fill="#7FD6F0"/><circle cx="146" cy="165" r="11" fill="#7FD6F0"/>${m == 'thumb' ? '<circle cx="188" cy="134" r="10" fill="#FFD166"/>' : ''}${m == 'cam' ? '<rect x="80" y="182" width="60" height="34" rx="12" fill="#FFD166"/><circle cx="110" cy="199" r="9" fill="#2B2A4C"/>' : ''}${m == 'think' ? '<circle cx="184" cy="40" r="7" fill="#BFEAF7"/><circle cx="200" cy="22" r="10" fill="#BFEAF7"/>' : ''}</svg>`;
}

/** Particle glyphs used by the floating robot bursts. */
export const GLYPHS: Record<'heart' | 'star', string> = {
  heart: '<path d="M0 8C-14 -2 -8 -14 0 -6C8 -14 14 -2 0 8z" fill="#FF9EC4"/>',
  star: '<path d="M0 -12L3.5 -3.5L12 0L3.5 3.5L0 12L-3.5 3.5L-12 0L-3.5 -3.5z" fill="#FFD166"/>',
};
