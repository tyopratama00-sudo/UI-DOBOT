import path from 'node:path';
import archiver from 'archiver';
import type { Logger } from 'pino';
import type { Photo, PrismaClient, Session } from '@photobooth/database';
import type { LocalStorageProvider, StorageProvider } from '@photobooth/storage';
import { contentTypeFor } from '@photobooth/storage';
import { robotSvg, iconSvg } from '@photobooth/ui';
import type { Env } from '../env';
import { randomToken } from '../util/crypto';
import type { SettingsService } from './settings';

export interface GalleryContext {
  session: Session;
  photos: Photo[];
  expired: boolean;
}

export interface GalleryLinks {
  frame: string | null;
  frameDownload: string | null;
  zip: string;
  photo: (p: Photo, variant: 'preview' | 'original', download?: boolean) => string;
}

export function photoFileName(p: Pick<Photo, 'angle' | 'shotNumber' | 'originalPath'>): string {
  const ext = path.extname(p.originalPath) || '.jpg';
  return `Sudut${String(p.angle + 1).padStart(2, '0')}_Foto${p.shotNumber + 1}${ext}`;
}

/**
 * Digital gallery: unguessable token (192-bit), expiry, page + downloads + ZIP.
 * In S3 mode every gallery file is replicated through the persistent upload
 * queue, so an internet outage only delays the upload instead of losing it.
 */
export class GalleryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    private readonly settings: SettingsService,
    private readonly store: LocalStorageProvider,
    readonly remote: StorageProvider | null,
    private readonly log: Logger,
  ) {}

  url(token: string): string {
    return this.env.GALLERY_MODE === 'static' ? `${this.env.galleryBaseUrl}/g/${token}/` : `${this.env.galleryBaseUrl}/g/${token}`;
  }

  async create(session: Session, opts: { rotate?: boolean } = {}): Promise<{ token: string; url: string; expiresAt: Date }> {
    const token = session.galleryToken && !opts.rotate ? session.galleryToken : randomToken(24);
    const expiresAt = new Date(Date.now() + this.settings.get().gallery.expirationHours * 3600_000);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { galleryToken: token, galleryCreatedAt: session.galleryCreatedAt ?? new Date(), galleryExpiresAt: expiresAt },
    });
    if (this.remote) await this.enqueueUploads(session.id, token);
    return { token, url: this.url(token), expiresAt };
  }

  async resolve(token: string): Promise<GalleryContext | null> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const session = await this.prisma.session.findUnique({ where: { galleryToken: token }, include: { photos: { orderBy: [{ angle: 'asc' }, { shotNumber: 'asc' }] } } });
    if (!session) return null;
    const expired = !session.galleryExpiresAt || session.galleryExpiresAt.getTime() < Date.now();
    return { session, photos: session.photos, expired };
  }

  // ---------------------------------------------------------------- remote replication

  remoteKeys(token: string, s: Session, photos: Photo[]) {
    const items: { key: string; localPath: string; contentType: string }[] = [];
    if (s.compositePath) items.push({ key: `g/${token}/frame${path.extname(s.compositePath)}`, localPath: s.compositePath, contentType: contentTypeFor(s.compositePath) });
    for (const p of photos) {
      items.push({ key: `g/${token}/photos/${photoFileName(p)}`, localPath: p.originalPath, contentType: contentTypeFor(p.originalPath) });
      if (p.previewPath) items.push({ key: `g/${token}/previews/${photoFileName(p).replace(/\.\w+$/, '.jpg')}`, localPath: p.previewPath, contentType: 'image/jpeg' });
    }
    return items;
  }

  private async enqueueUploads(sessionId: string, token: string) {
    const s = await this.prisma.session.findUniqueOrThrow({ where: { id: sessionId }, include: { photos: true } });
    const items = this.remoteKeys(token, s, s.photos);
    // ZIP and static page are generated locally first, then uploaded like any other file.
    const zipKey = `sessions/${sessionId}/output/photos-${token.slice(0, 8)}.zip`;
    await this.writeZipToStore(s, s.photos, zipKey);
    items.push({ key: `g/${token}/photos.zip`, localPath: zipKey, contentType: 'application/zip' });
    if (this.env.GALLERY_MODE === 'static') {
      const htmlKey = `sessions/${sessionId}/output/gallery-${token.slice(0, 8)}.html`;
      const html = this.renderPage({ session: s, photos: s.photos, expired: false }, this.staticLinks(s));
      await this.store.put(htmlKey, Buffer.from(html, 'utf8'));
      items.push({ key: `g/${token}/index.html`, localPath: htmlKey, contentType: 'text/html; charset=utf-8' });
    }
    for (const it of items) {
      await this.prisma.uploadJob.upsert({
        where: { key: it.key },
        create: { sessionId, key: it.key, localPath: it.localPath, contentType: it.contentType },
        update: { localPath: it.localPath, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), error: null },
      });
    }
    this.log.info({ event: 'gallery_upload_enqueued', sessionId, files: items.length }, 'gallery files queued for upload');
  }

  /** Presigned / public URL for a replicated file, or null when not uploaded yet. */
  async remoteUrl(key: string, expiresAt: Date): Promise<string | null> {
    if (!this.remote) return null;
    const job = await this.prisma.uploadJob.findUnique({ where: { key } });
    if (!job || job.status !== 'DONE') return null;
    return this.remote.getSignedUrl(key, Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
  }

  // ---------------------------------------------------------------- zip

  async appendToArchive(archive: archiver.Archiver, s: Session, photos: Photo[]) {
    if (s.compositePath && (await this.store.exists(s.compositePath))) {
      archive.file(this.store.resolve(s.compositePath), { name: `Frame_${s.sessionCode}${path.extname(s.compositePath)}` });
    }
    for (const p of photos) {
      if (await this.store.exists(p.originalPath)) archive.file(this.store.resolve(p.originalPath), { name: `Foto/${photoFileName(p)}` });
    }
  }

  private async writeZipToStore(s: Session, photos: Photo[], key: string) {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const done = this.store.put(key, archive);
    await this.appendToArchive(archive, s, photos);
    await archive.finalize();
    await done;
  }

  // ---------------------------------------------------------------- HTML

  serverLinks(token: string, s: Session): GalleryLinks {
    const base = `/g/${token}`;
    return {
      frame: s.compositePath ? `${base}/frame` : null,
      frameDownload: s.compositePath ? `${base}/frame?download=1` : null,
      zip: `${base}/zip`,
      photo: (p, variant, download) => `${base}/p/${p.id}/${variant}${download ? '?download=1' : ''}`,
    };
  }

  staticLinks(s: Session): GalleryLinks {
    const frame = s.compositePath ? `frame${path.extname(s.compositePath)}` : null;
    return {
      frame,
      frameDownload: frame,
      zip: 'photos.zip',
      photo: (p, variant) => (variant === 'original' ? `photos/${photoFileName(p)}` : `previews/${photoFileName(p).replace(/\.\w+$/, '.jpg')}`),
    };
  }

  renderPage(ctx: GalleryContext, links: GalleryLinks): string {
    const { session: s, photos } = ctx;
    const exp = s.galleryExpiresAt ? s.galleryExpiresAt.toISOString() : '';
    const expText = s.galleryExpiresAt
      ? s.galleryExpiresAt.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB'
      : '';
    // Every photo of the session is delivered (retakes included, nothing is withheld).
    const visible = photos;
    const cards = visible
      .map(
        (p) => `<figure class="ph"><a href="${links.photo(p, 'preview')}" target="_blank" rel="noopener"><img loading="lazy" src="${links.photo(p, 'preview')}" alt="Sudut ${p.angle + 1} foto ${p.shotNumber + 1}"></a><figcaption><span>Sudut ${String(p.angle + 1).padStart(2, '0')}${p.retaken ? ' · ulang' : ''}</span><a class="dl" href="${links.photo(p, 'original', true)}" download="${photoFileName(p)}" aria-label="Unduh">${iconSvg('download', 22)}</a></figcaption></figure>`,
      )
      .join('');
    return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Foto Robot Photobooth · ${s.sessionCode}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#FAF8F3;--pk:#FFC7DE;--mi:#BDEBD3;--lv:#DCCBFF;--pe:#FFD9B0;--ink:#2B2A4C;--cy:#7FD6F0;--bl:#5B7CFA;--ye:#FFD166;--mu:#7A7A9D}
*{box-sizing:border-box;margin:0}body{font-family:'Fredoka','Trebuchet MS',sans-serif;color:var(--ink);background:radial-gradient(#E6E0D2 1.2px,transparent 1.3px) 0 0/28px 28px,var(--bg);min-height:100vh}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;align-items:center;gap:14px;margin-bottom:18px}header .rb{flex:none}
h1{font-size:clamp(28px,6vw,46px);font-weight:700;line-height:1.05;text-transform:uppercase;letter-spacing:-1px}
.p{color:var(--mu);font-size:18px;margin-top:6px}
.chip{display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:18px;background:var(--lv);color:#4A3FA0;font-weight:600;font-size:15px}
.hero{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;margin:20px 0 28px}
@media(min-width:820px){.hero{grid-template-columns:minmax(0,420px) 1fr;align-items:start}}
.frame{background:#fff;border-radius:28px;padding:16px;box-shadow:0 1px 0 rgba(43,42,76,.06),0 24px 40px -28px rgba(43,42,76,.35);border:1.5px solid rgba(43,42,76,.07);text-align:center}
.frame img{max-width:100%;max-height:70vh;border-radius:14px}
.btns{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:56px;padding:0 26px;border-radius:22px;font:600 18px 'Fredoka',sans-serif;text-decoration:none;color:var(--ink);background:#fff;box-shadow:0 5px 0 #DCD6E8;border:1.5px solid rgba(43,42,76,.07)}
.btn:active{transform:translateY(4px);box-shadow:0 1px 0 #DCD6E8}.btn.pr{background:var(--bl);color:#fff;box-shadow:0 6px 0 #3B55C4;border:0}.btn.ye{background:var(--ye);box-shadow:0 6px 0 #E2AE3C;border:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.ph{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 18px 30px -24px rgba(43,42,76,.4);border:1.5px solid rgba(43,42,76,.07)}
.ph img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}
.ph figcaption{display:flex;justify-content:space-between;align-items:center;padding:6px 6px 6px 12px;font-weight:600;font-size:14px}
.dl{display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;border-radius:14px;background:var(--soft,#E3F2FF);color:var(--ink)}
h2{font-size:26px;margin:8px 0 14px}.foot{margin-top:28px;color:var(--mu);font-size:15px;text-align:center}
.exp{display:none;padding:18px;border-radius:20px;background:#FDE0DD;color:#F0564A;font-weight:600;margin:16px 0}
@media(prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head><body><main data-expires="${exp}">
<header>${robotSvg('cheer', 96)}<div><span class="chip">Robot Photobooth · ${s.sessionCode}</span><h1>Foto digitalmu</h1><p class="p">Simpan sebelum ${expText}</p></div></header>
<div class="exp" id="exp">Galeri ini sudah kedaluwarsa.</div>
<section class="hero">${
      links.frame
        ? `<div class="frame"><img src="${links.frame}" alt="Frame foto"><div class="btns" style="justify-content:center"><a class="btn pr" href="${links.frameDownload}" download>${iconSvg('download', 24)} Unduh frame</a></div></div>`
        : ''
    }<div><h2>Semua momen dari ${new Set(photos.map((p) => p.angle)).size} sudut</h2><p class="p">Ketuk foto untuk melihat ukuran penuh, atau unduh semuanya sekaligus.</p><div class="btns"><a class="btn ye" href="${links.zip}" download>${iconSvg('download', 24)} Unduh semua (ZIP)</a></div></div></section>
<section><div class="grid">${cards}</div></section>
<p class="foot">Semoga seru bersama fotografer robotmu!</p></main>
<script>(function(){var e=document.querySelector('main').getAttribute('data-expires');if(e&&new Date(e)<new Date()){document.getElementById('exp').style.display='block';document.querySelectorAll('.hero,.grid').forEach(function(n){n.style.display='none'})}})();</script>
</body></html>`;
  }

  renderExpired(): string {
    return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Galeri kedaluwarsa</title><style>body{font-family:'Fredoka','Trebuchet MS',sans-serif;background:#FAF8F3;color:#2B2A4C;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}h1{font-size:32px;margin:12px 0}p{color:#7A7A9D;font-size:18px}</style></head><body><div>${robotSvg('think', 160)}<h1>Galeri sudah kedaluwarsa</h1><p>Link foto ini tidak berlaku lagi. Hubungi petugas booth jika kamu butuh bantuan.</p></div></body></html>`;
  }
}
