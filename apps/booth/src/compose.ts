import { computeFrameLayout, filterById, type EditParams, type PhotoDTO, type PhotoTemplate } from '@photobooth/shared';

const load = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`Gagal memuat gambar ${src}`));
    img.src = src;
  });

/**
 * Renders the frame exactly like <Frame> does on screen (cover-fit photo, then
 * translate/rotate/scale + CSS filter, clipped to the slot, artwork on top) and
 * returns a JPEG for POST /api/photo/compose.
 */
export async function composeFrame(t: PhotoTemplate, photos: (PhotoDTO | undefined)[], edits: Record<number, EditParams>): Promise<Blob> {
  const H = t.overlay ? t.overlay.height * 3 : 1800;
  const L = computeFrameLayout(t, H);
  const c = document.createElement('canvas');
  c.width = Math.round(L.width);
  c.height = Math.round(L.height);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = t.overlay ? '#fff' : t.background;
  ctx.fillRect(0, 0, c.width, c.height);

  const imgs = await Promise.all(photos.map((p) => (p ? load(p.previewUrl) : null)));
  L.slots.forEach((r, i) => {
    const img = imgs[i];
    if (!img) return;
    const e = edits[i];
    ctx.save();
    ctx.beginPath();
    if (r.round) ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else if (L.slotRadius) ctx.roundRect(r.x, r.y, r.w, r.h, L.slotRadius);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.translate(r.x + r.w / 2 + (e?.x ?? 0) * r.w, r.y + r.h / 2 + (e?.y ?? 0) * r.h);
    ctx.rotate(((e?.rotation ?? 0) * Math.PI) / 180);
    const z = e?.zoom ?? 1;
    ctx.scale(e?.flipHorizontal ? -z : z, z);
    if (e) ctx.filter = `brightness(${e.brightness}) ${filterById(e.filter).css}`.trim();
    const s = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  });

  if (t.overlay) ctx.drawImage(await load(t.overlay.image), 0, 0, c.width, c.height);

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Export frame gagal'))), 'image/jpeg', 0.92));
}
