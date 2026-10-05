import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { iconSvg, robotSvg, posedRobotSvg, qrModulesSvg, type IconName, type RobotMood } from '@photobooth/ui';
import { TIP_CATEGORY_COLORS, type PoseTip } from '@photobooth/shared';

/** Raw SVG markup (prototype generators) rendered without a layout wrapper. */
export const Svg = memo(function Svg({ html, className, style }: { html: string; className?: string; style?: CSSProperties }) {
  return <span className={className} style={{ display: 'contents', ...style }} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** prototype IC(name, size, color) */
export function Icon({ n, z = 44, c = 'currentColor' }: { n: IconName; z?: number; c?: string }) {
  const html = useMemo(() => iconSvg(n, z, c), [n, z, c]);
  return <Svg html={html} />;
}

/** prototype R(mood, size) — memoized so the idle animation keeps its phase */
export function Robot({ m = 'hi', s = 240 }: { m?: RobotMood; s?: number }) {
  const html = useMemo(() => robotSvg(m, s), [m, s]);
  return <Svg html={html} />;
}

/** prototype RP(pose, size) */
export function PosedRobot({ pose, s = 250 }: { pose: string; s?: number }) {
  const html = useMemo(() => posedRobotSvg(pose, s), [pose, s]);
  return <Svg html={html} />;
}

/** prototype bub(text, small) */
export function Bubble({ children, small, style }: { children: ReactNode; small?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="bub" style={style}>
      {children}
      {small ? <small>{small}</small> : null}
    </div>
  );
}

/** prototype tipCard(tip, animate) */
export function TipCard({ t, animate }: { t: PoseTip; animate?: boolean }) {
  return (
    <div className={`card ${animate ? 'tip' : ''}`} style={{ width: '100%', padding: '24px 30px' }}>
      <span className="chip" style={{ height: 46, fontSize: 24, letterSpacing: '.14em', padding: '0 20px', background: TIP_CATEGORY_COLORS[t[0]], boxShadow: 'none', border: 0 }}>
        {t[0]}
      </span>
      <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.1, margin: '14px 0 6px' }}>{t[1]}</div>
      <div style={{ fontSize: 28, color: 'var(--mu)', lineHeight: 1.25 }}>{t[2]}</div>
    </div>
  );
}

/** Real QR code drawn in the prototype QR style (ink modules, quiet margin). */
export const QrCode = memo(function QrCode({ text, size, level = 'M' }: { text: string; size: number; level?: 'L' | 'M' | 'Q' | 'H' }) {
  const html = useMemo(() => {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: level });
      const n = qr.modules.size;
      const rows: boolean[][] = [];
      for (let y = 0; y < n; y++) {
        const row: boolean[] = [];
        for (let x = 0; x < n; x++) row.push(!!qr.modules.data[y * n + x]);
        rows.push(row);
      }
      return qrModulesSvg(rows, size);
    } catch {
      return '';
    }
  }, [text, size, level]);
  return <Svg html={html} />;
});

/** A photo in the prototype `.ph` box (cover-fitted real image). */
export function Pic({ url, className = '', style, children }: { url?: string; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={`ph ${url ? '' : 'empty'} ${className}`} style={style}>
      {url ? <img className="pic" src={url} alt="" draggable={false} decoding="async" /> : null}
      {children}
    </div>
  );
}

export function Btn({
  children,
  className = '',
  onClick,
  disabled,
  busy,
  style,
  testId,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <button className={`btn ${className} ${busy ? 'wait' : ''}`} style={style} disabled={disabled} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  );
}
