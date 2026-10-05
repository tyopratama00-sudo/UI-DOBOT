import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

/**
 * Storage abstraction. Keys are POSIX-style relative paths such as
 * `sessions/<id>/original/a01_s01.jpg`. Every key is sanitized so a caller can
 * never escape the storage root (path traversal) or hit odd characters.
 */
export interface StorageStat {
  size: number;
  modified: Date;
}

export interface StorageHealth {
  ok: boolean;
  status: 'ok' | 'degraded' | 'down';
  message: string;
  freeBytes?: number;
  totalBytes?: number;
}

export interface StorageProvider {
  readonly name: 'local' | 's3';
  put(key: string, data: Buffer | Readable, contentType?: string): Promise<void>;
  get(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StorageStat | null>;
  delete(key: string): Promise<void>;
  /** Direct (presigned / public) URL when the provider can serve files itself. */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  health(): Promise<StorageHealth>;
}

export class StorageKeyError extends Error {
  readonly code = 'INVALID_STORAGE_KEY';
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sanitizeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new StorageKeyError('Empty or too long key');
  const normalized = key.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new StorageKeyError('Absolute keys are not allowed');
  const parts = normalized.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || !SEGMENT.test(p)) throw new StorageKeyError(`Invalid key segment "${p}"`);
  }
  return parts.join('/');
}

export function contentTypeFor(key: string): string {
  const ext = path.extname(key).toLowerCase();
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.zip': 'application/zip',
      '.json': 'application/json',
      '.html': 'text/html; charset=utf-8',
      '.pdf': 'application/pdf',
    }[ext] ?? 'application/octet-stream'
  );
}

// ---------------------------------------------------------------- local / NAS

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;
  readonly root: string;

  constructor(
    root: string,
    private readonly thresholds = { degradedBytes: 2 * 1024 ** 3, downBytes: 200 * 1024 ** 2 },
  ) {
    this.root = path.resolve(root);
  }

  /** Absolute path for a key; guaranteed to live inside the root. */
  resolve(key: string): string {
    const safe = sanitizeKey(key);
    const full = path.resolve(this.root, ...safe.split('/'));
    const rel = path.relative(this.root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new StorageKeyError('Key escapes storage root');
    return full;
  }

  async put(key: string, data: Buffer | Readable): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Atomic write: temp file + rename, so a crash never leaves half a photo.
    const tmp = `${full}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      if (Buffer.isBuffer(data)) await fs.writeFile(tmp, data);
      else await pipeline(data, createWriteStream(tmp));
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async get(key: string): Promise<Readable> {
    const full = this.resolve(key);
    await fs.access(full);
    return createReadStream(full);
  }

  async getBuffer(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    try {
      const s = await fs.stat(this.resolve(key));
      return { size: s.size, modified: s.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async getSignedUrl(): Promise<string | null> {
    return null;
  }

  async health(): Promise<StorageHealth> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.probe-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.rm(probe, { force: true });
      let freeBytes: number | undefined;
      let totalBytes: number | undefined;
      if (typeof (fs as { statfs?: unknown }).statfs === 'function') {
        const s = await fs.statfs(this.root);
        freeBytes = Number(s.bavail) * Number(s.bsize);
        totalBytes = Number(s.blocks) * Number(s.bsize);
      }
      if (freeBytes !== undefined && freeBytes < this.thresholds.downBytes)
        return { ok: false, status: 'down', message: 'Storage full', freeBytes, totalBytes };
      if (freeBytes !== undefined && freeBytes < this.thresholds.degradedBytes)
        return { ok: true, status: 'degraded', message: 'Storage almost full', freeBytes, totalBytes };
      return { ok: true, status: 'ok', message: 'Ready', freeBytes, totalBytes };
    } catch (err) {
      return { ok: false, status: 'down', message: `Storage not writable: ${(err as Error).message}` };
    }
  }
}

// ---------------------------------------------------------------- S3 compatible

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  /** If the bucket/CDN is public, objects are linked directly instead of presigned. */
  publicUrl?: string;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client>;

  constructor(private readonly cfg: S3Config) {
    this.clientPromise = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: cfg.region,
          endpoint: cfg.endpoint || undefined,
          forcePathStyle: cfg.forcePathStyle,
          credentials:
            cfg.accessKeyId && cfg.secretAccessKey
              ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
              : undefined,
        }),
    );
  }

  private k(key: string): string {
    const safe = sanitizeKey(key);
    return this.cfg.prefix ? `${this.cfg.prefix.replace(/\/+$/, '')}/${safe}` : safe;
  }

  async put(key: string, data: Buffer | Readable, contentType?: string): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    const body = Buffer.isBuffer(data) ? data : await streamToBuffer(data);
    await client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key), Body: body, ContentType: contentType ?? contentTypeFor(key) }),
    );
  }

  async get(key: string): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    const res = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }));
    return res.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    return streamToBuffer(await this.get(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageStat | null> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }));
      return { size: Number(r.ContentLength ?? 0), modified: r.LastModified ?? new Date(0) };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientPromise;
    await client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }));
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    if (this.cfg.publicUrl) return `${this.cfg.publicUrl.replace(/\/+$/, '')}/${this.k(key)}`;
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.clientPromise;
    // S3 presigned URLs are limited to 7 days.
    const expiresIn = Math.max(60, Math.min(expiresInSeconds, 7 * 24 * 3600));
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }), { expiresIn });
  }

  async health(): Promise<StorageHealth> {
    const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
    try {
      const client = await this.clientPromise;
      await client.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
      return { ok: true, status: 'ok', message: `Bucket ${this.cfg.bucket} reachable` };
    } catch (err) {
      return { ok: false, status: 'down', message: `S3 unreachable: ${(err as Error).name}` };
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

export interface StorageEnv {
  provider: 'local' | 's3';
  localPath: string;
  s3?: S3Config;
}

export function createStorage(env: StorageEnv): StorageProvider {
  if (env.provider === 's3') {
    if (!env.s3?.bucket) throw new Error('STORAGE_PROVIDER=s3 requires S3_BUCKET');
    return new S3StorageProvider(env.s3);
  }
  return new LocalStorageProvider(env.localPath);
}
