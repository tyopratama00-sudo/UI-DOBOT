import { useState } from 'react';
import { dt, get, post } from '../api';
import { statusChip, useAction, usePoll } from '../ui';

export function PrintQueue() {
  const [status, setStatus] = useState('');
  const [jobs, reload] = usePoll<any[]>(() => get(`/api/admin/print-jobs${status ? `?status=${status}` : ''}`), 4000, [status]);
  const [uploads, reloadUploads] = usePoll<any[]>(() => get('/api/admin/upload-jobs'), 10000);
  const { busy, run } = useAction();
  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    await run(name, fn, ok);
    await reload();
  };
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Print queue</h1>
      <div className="card row">
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All jobs</option>
          {['QUEUED', 'RENDERING', 'PRINTING', 'RETRYING', 'FAILED', 'COMPLETED', 'CANCELLED'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="mu small">Jobs are persisted; failed jobs retry automatically with backoff, then wait for an admin retry.</span>
      </div>
      <div className="card tbl">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Copies</th>
              <th>Printer</th>
              <th>Attempts</th>
              <th>Created</th>
              <th>Error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs?.map((j) => (
              <tr key={j.id}>
                <td>
                  <a className="mono" href={`#/sessions/${j.sessionId}`}>
                    {j.session?.sessionCode}
                  </a>{' '}
                  {j.isReprint ? <span className="chip mu">reprint</span> : null}
                </td>
                <td>
                  {statusChip(j.status)} {['PRINTING', 'RENDERING'].includes(j.status) ? <span className="small">{j.progress}%</span> : null}
                </td>
                <td>{j.copies}</td>
                <td className="small">{j.printer}</td>
                <td>
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="small">{dt(j.createdAt)}</td>
                <td className="small" style={{ color: 'var(--er)', maxWidth: 260 }}>
                  {j.errorCode ? `${j.errorCode}: ` : ''}
                  {j.error}
                </td>
                <td>
                  <div className="btns">
                    {['FAILED', 'RETRYING', 'CANCELLED'].includes(j.status) ? (
                      <button className="btn pr" disabled={busy !== null} onClick={() => act('retry', () => post(`/api/admin/print-jobs/${j.id}/retry`), 'Job re-queued')}>
                        Retry
                      </button>
                    ) : null}
                    {['QUEUED', 'RETRYING', 'PRINTING'].includes(j.status) ? (
                      <button className="btn er" disabled={busy !== null} onClick={() => act('cancel', () => post(`/api/admin/print-jobs/${j.id}/cancel`), 'Job cancelled')}>
                        Cancel
                      </button>
                    ) : null}
                    {j.status === 'COMPLETED' ? (
                      <button className="btn" disabled={busy !== null} onClick={() => act('reprint', () => post(`/api/admin/sessions/${j.sessionId}/reprint`, { copies: j.copies }), 'Reprint queued')}>
                        Reprint
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!jobs?.length ? <div className="mu">No print jobs.</div> : null}
      </div>

      <div className="card tbl">
        <div className="row">
          <h2 style={{ margin: 0 }}>Cloud upload queue</h2>
          <div className="spacer" />
          <button className="btn" onClick={() => run('up', () => post('/api/admin/upload-jobs/retry-failed'), 'Failed uploads re-queued').then(() => reloadUploads())}>
            Retry failed uploads
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {uploads?.slice(0, 50).map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.key}</td>
                <td>{statusChip(u.status)}</td>
                <td>{u.attempts}</td>
                <td className="small">{u.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!uploads?.length ? <div className="mu small">Empty (STORAGE_PROVIDER=local keeps everything on the booth).</div> : null}
      </div>
    </div>
  );
}
