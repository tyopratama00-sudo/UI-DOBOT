/**
 * Prototype `ph(id)` illustration as a standalone SVG. Used by the MOCK camera
 * driver so development sessions look exactly like the prototype, while the
 * whole pipeline (storage, thumbnails, editing, rendering, printing) runs on
 * real image files.
 */

export function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const SK = ['#F3C9A5', '#E0A97F', '#C68B5E', '#8D5A3B'];
const HR = ['#2B2A4C', '#5B3A29', '#B5651D', '#1B1B1B'];

export function placeholderFigures(id: string): string {
  const h = hue(id);
  const a = h % 4;
  const b = (h >> 2) % 4;
  const v = (h >> 3) % 3;
  const sh1 = `hsl(${(h + 120) % 360},60%,64%)`;
  const sh2 = `hsl(${(h + 200) % 360},55%,72%)`;
  const fig = (cx: number, r: number, sh: string, sk: string, hr: string) =>
    `<rect x="${cx - r * 1.7}" y="64" width="${r * 3.4}" height="60" rx="${r * 1.5}" fill="${sh}"/><circle cx="${cx}" cy="52" r="${r}" fill="${sk}"/><path d="M${cx - r} 50a${r} ${r} 0 0 1 ${r * 2} 0z" fill="${hr}"/><circle cx="${cx - r * 0.35}" cy="53" r="1.1" fill="#2B2A4C"/><circle cx="${cx + r * 0.35}" cy="53" r="1.1" fill="#2B2A4C"/><path d="M${cx - r * 0.3} 57q${r * 0.3} 2 ${r * 0.6} 0" stroke="#2B2A4C" stroke-width="1" fill="none" stroke-linecap="round"/>`;
  const x0 = v == 1 ? 26 + (h % 6) : 0;
  const up =
    v == 1
      ? `<path d="M${x0 + 8} 72L${x0} 46" stroke="${sh1}" stroke-width="7" stroke-linecap="round"/><circle cx="${x0}" cy="43" r="4.5" fill="${SK[a]}"/>`
      : '';
  return (v == 2 ? fig(50, 15, sh1, SK[a], HR[b]) : fig(36 + (h % 9), 11, sh1, SK[a], HR[b]) + fig(65 - (h % 9), 10, sh2, SK[b], HR[a])) + up;
}

export function placeholderPhotoSvg(id: string, width: number, height: number, caption = ''): string {
  const h = hue(id);
  const split = height * 0.74;
  const cap = caption
    ? `<g font-family="Fredoka, 'Trebuchet MS', sans-serif" font-weight="600"><rect x="${width * 0.02}" y="${height * 0.03}" rx="${height * 0.02}" width="${caption.length * height * 0.022 + height * 0.04}" height="${height * 0.065}" fill="rgba(255,255,255,.85)"/><text x="${width * 0.02 + height * 0.02}" y="${height * 0.075}" font-size="${height * 0.04}" fill="#2B2A4C">${caption.replace(/[<>&]/g, '')}</text></g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${split}" fill="hsl(${h},70%,87%)"/><rect y="${split}" width="${width}" height="${height - split}" fill="hsl(${h},40%,80%)"/><svg x="0" y="0" width="${width}" height="${height}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMax slice">${placeholderFigures(id)}</svg>${cap}</svg>`;
}

/** Prototype QR look: one rect per dark module, ink colour, 1-module quiet margin. */
export function qrModulesSvg(modules: boolean[][], size: number, fill = '#2B2A4C'): string {
  const n = modules.length;
  let c = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && modules[y][x + run]) run++;
      c += `<rect x="${x}" y="${y}" width="${run + 0.02}" height="1.02"/>`;
      x += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${n + 2} ${n + 2}" width="${size}" height="${size}" fill="${fill}" shape-rendering="crispEdges">${c}</svg>`;
}
