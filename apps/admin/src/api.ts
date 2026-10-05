export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function http<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.endsWith('/login')) onUnauthorized?.();
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: { message: text } };
  }
  if (!res.ok) throw new HttpError(res.status, json?.error?.code ?? 'HTTP_' + res.status, json?.error?.message ?? res.statusText);
  return json as T;
}

export const get = <T = any>(p: string) => http<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => http<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => http<T>('PUT', p, b);
export const del = <T = any>(p: string) => http<T>('DELETE', p);

export const rp = (n: number) => 'Rp' + (n ?? 0).toLocaleString('id-ID');
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const ago = (s: string) => {
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
};
