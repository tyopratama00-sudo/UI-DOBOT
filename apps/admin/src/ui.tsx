import { useEffect, useRef, useState } from 'react';

type Toast = { id: number; text: string; err?: boolean };
let push: ((t: Omit<Toast, 'id'>) => void) | null = null;

export function toast(text: string, err = false) {
  push?.({ text, err });
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    push = (t) => {
      const id = Date.now() + Math.random();
      setList((l) => [...l, { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 4500);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <>
      {list.map((t, i) => (
        <div key={t.id} className={`toast ${t.err ? 'err' : ''}`} style={{ bottom: 20 + i * 64 }}>
          {t.text}
        </div>
      ))}
    </>
  );
}

/** Polls a loader; returns [data, reload, error]. */
export function usePoll<T>(loader: () => Promise<T>, intervalMs = 0, deps: unknown[] = []): [T | null, () => Promise<void>, string | null] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef(loader);
  ref.current = loader;
  const reload = async () => {
    try {
      setData(await ref.current());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const t = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [data, reload, err];
}

export function statusChip(status: string) {
  const s = status.toUpperCase();
  const cls =
    ['OK', 'COMPLETED', 'PAID', 'FINISHED', 'QR_READY', 'DONE', 'READY', 'PRINT_SUCCESS', 'INFO'].includes(s)
      ? 'ok'
      : ['ERROR', 'FAILED', 'DOWN', 'PRINT_FAILED', 'CANCELLED', 'EXPIRED'].includes(s)
        ? 'err'
        : ['DEGRADED', 'RETRYING', 'PENDING', 'WAITING_PAYMENT', 'WARN', 'QUEUED', 'UNKNOWN', 'PRINTING', 'RENDERING', 'UPLOADING'].includes(s)
          ? 'warn'
          : '';
  return <span className={`chip ${cls}`}>{status}</span>;
}

export function healthDot(status: string) {
  const c = status === 'ok' ? 'var(--ok)' : status === 'down' ? 'var(--er)' : status === 'degraded' ? 'var(--ye)' : 'var(--mu)';
  return <span className="dot" style={{ background: c }} />;
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(name);
    try {
      const r = await fn();
      const msg = okText ?? (r && typeof r === 'object' && 'message' in (r as object) ? String((r as { message: string }).message) : 'Done');
      toast(msg, !!r && typeof r === 'object' && (r as { ok?: boolean }).ok === false);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}
