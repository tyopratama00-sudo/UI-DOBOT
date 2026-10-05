import sharp from 'sharp';
import type { LocalStorageProvider } from '@photobooth/storage';
import { signMedia } from '../util/crypto';
import { appError } from '../errors';

export interface IngestedPhoto {
  originalKey: string;
  previewKey: string;
  thumbKey: string;
  width: number;
  height: number;
  bytes: number;
}

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'tiff', 'heif']);

/**
 * Photo ingest + signed media URLs.
 * The original bytes are stored untouched (never modified); preview & thumbnail
 * derivatives are auto-oriented copies used by the booth UI.
 */
export class MediaService {
  constructor(
    private readonly store: LocalStorageProvider,
    private readonly secret: string,
  ) {}

  url(key: string, ttlSeconds = 6 * 3600): string {
    const e = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `/media/${key}?e=${e}&s=${signMedia(key, e, this.secret)}`;
  }

  async ingestPhoto(sessionId: string, angle: number, shotNumber: number, data: Buffer): Promise<IngestedPhoto> {
    let meta: sharp.Metadata;
    try {
      meta = await sharp(data, { failOn: 'error' }).metadata();
    } catch {
      throw appError('CAMERA_CAPTURE_FAILED', 422, 'Uploaded file is not a valid image');
    }
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) throw appError('CAMERA_CAPTURE_FAILED', 422, `Unsupported image format ${meta.format}`);
    if (!meta.width || !meta.height || meta.width < 200 || meta.height < 150) throw appError('CAMERA_CAPTURE_FAILED', 422, 'Image too small');
    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format;
    const name = `a${String(angle + 1).padStart(2, '0')}_s${String(shotNumber + 1).padStart(2, '0')}`;
    const base = `sessions/${sessionId}`;
    const originalKey = `${base}/original/${name}.${ext}`;
    const previewKey = `${base}/preview/${name}.jpg`;
    const thumbKey = `${base}/thumb/${name}.jpg`;

    await this.store.put(originalKey, data);
    const oriented = sharp(data).rotate();
    const [preview, thumb] = await Promise.all([
      oriented.clone().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
      oriented.clone().resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer(),
    ]);
    await Promise.all([this.store.put(previewKey, preview), this.store.put(thumbKey, thumb)]);
    const swap = (meta.orientation ?? 1) >= 5;
    return {
      originalKey,
      previewKey,
      thumbKey,
      width: swap ? meta.height : meta.width,
      height: swap ? meta.width : meta.height,
      bytes: data.length,
    };
  }
}
