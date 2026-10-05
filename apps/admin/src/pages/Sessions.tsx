import { useState } from 'react';
import { SESSION_STATES } from '@photobooth/shared';
import { dt, get, post, rp } from '../api';
import { statusChip, useAction, usePoll } from '../ui';

export function Sessions() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, reload] = usePoll<any>(
    () => get(`/api/admin/sessions?page=${page}&pageSize=25${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    15000,
    [status, q, page],
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Sessions</h1>
      <div className="card row">
        <input placeholder="Search code (RPB-…) or id" value={q} onChange={(e) => (setPage(1), setQ(e.target.value))} style={{ maxWidth: 280 }} />
        <select value={status} onChange={(e) => (setPage(1), setStatus(e.target.value))} style={{ maxWidth: 240 }}>
          <option value="">All statuses</option>
          {SESSION_STATES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <div className="card tbl">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Created</th>
              <th>Paid</th>
              <th>Prints</th>
              <th>Frame</th>
              <th>Photos</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((s: any) => (
              <tr key={s.id} className="click" onClick={() => (location.hash = `#/sessions/${s.id}`)}>
                <td className="mono">{s.sessionCode}</td>
                <td>
                  {statusChip(s.status)} {s.autoCompleted ? <span className="chip mu">auto</span> : null} {s.errorCode ? <span className="chip err">{s.errorCode}</span> : null}
                </td>
                <td>{dt(s.createdAt)}</td>
                <td>{s.paidAt ? rp(s.amount) : <span className="mu">—</span>}</td>
                <td>{s.printQuantity}</td>
                <td>{s.selectedTemplate ?? <span className="mu">—</span>}</td>
                <td>{s._count.photos}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="mu small">{data?.total ?? 0} sessions</span>
          <div className="spacer" />
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Prev
          </button>
          <span className="small">
            {page} / {pages}
          </span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
        </div>
      </div>
    </div>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const [d, reload, err] = usePoll<any>(() => get(`/api/admin/sessions/${id}`), 5000, [id]);
  const [copies, setCopies] = useState(1);
  const [gallery, setGallery] = useState<any>(null);
  const { busy, run } = useAction();
  if (!d) return <div className="mu">{err ?? 'Loading…'}</div>;
  const s = d.snapshot;
  const g = gallery ?? d.gallery;
  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    await run(name, fn, ok);
    await reload();
  };
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row">
        <a href="#/sessions">‹ Sessions</a>
      </div>
      <div className="row">
        <h1 style={{ margin: 0 }} className="mono">
          {s.code}
        </h1>
        {statusChip(s.status)}
        {d.autoCompleted ? <span className="chip mu">auto-completed</span> : null}
        {d.errorCode ? <span className="chip err">{d.errorCode}</span> : null}
        <div className="spacer" />
        <span className="mu">{dt(s.createdAt)}</span>
      </div>
      {d.errorMessage ? <div className="card chip err" style={{ borderRadius: 14 }}>{d.errorMessage}</div> : null}

      <div className="grid g3">
        <div className="card">
          <h3>Payment</h3>
          <div>{s.paidAt ? <b>{rp(s.amount)}</b> : <span className="mu">Not paid</span>}</div>
          <div className="small mu">
            {s.quantity} print(s) · paid {dt(s.paidAt)}
          </div>
        </div>
        <div className="card">
          <h3>Frame</h3>
          <div>{s.templateId ?? '—'}</div>
          <div className="small mu">
            {s.slots.length} slot(s) · {s.photos.length} photos · retakes {s.retakenAngles.map((a: number) => a + 1).join(', ') || 'none'}
          </div>
        </div>
        <div className="card">
          <h3>Print</h3>
          {s.print ? (
            <div>
              {statusChip(s.print.status)} <span className="small">{s.print.progress}%</span>
              {s.print.error ? <div className="small" style={{ color: 'var(--er)' }}>{s.print.error}</div> : null}
            </div>
          ) : (
            <span className="mu">No print job</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Actions</h2>
        <div className="btns">
          <input type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(Number(e.target.value))} style={{ width: 80 }} />
          <button className="btn pr" disabled={!s.slots.length || busy !== null} onClick={() => act('reprint', () => post(`/api/admin/sessions/${id}/reprint`, { copies }), 'Reprint queued')}>
            Reprint
          </button>
          <button className="btn" disabled={busy !== null || !s.photos.length} onClick={() => act('gal', async () => setGallery(await post(`/api/admin/sessions/${id}/regenerate-gallery`)), 'New gallery link created')}>
            Regenerate QR / gallery link
          </button>
          <button className="btn" disabled={busy !== null || !s.slots.length} onClick={() => act('rr', () => post(`/api/admin/sessions/${id}/rerender`), 'Re-rendered')}>
            Re-render composite
          </button>
          {s.status === 'ERROR' ? (
            <>
              <button className="btn ye" onClick={() => act('resume', () => post(`/api/admin/sessions/${id}/resume`, { target: 'REVIEW' }))}>
                Resume at review
              </button>
              <button className="btn ye" onClick={() => act('resume', () => post(`/api/admin/sessions/${id}/resume`, { target: 'READY' }))}>
                Resume capture
              </button>
              <button className="btn ye" onClick={() => act('resume', () => post(`/api/admin/sessions/${id}/resume`, { target: 'QR_READY' }))}>
                Jump to QR
              </button>
            </>
          ) : null}
          <button
            className="btn er"
            disabled={['FINISHED', 'CANCELLED', 'EXPIRED'].includes(s.status)}
            onClick={() => confirm('Cancel this session?') && act('cancel', () => post(`/api/admin/sessions/${id}/cancel`), 'Session cancelled')}
          >
            Cancel session
          </button>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Final frame</h2>
          {d.compositeUrl ? (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <a href={d.compositeUrl} target="_blank" rel="noreferrer">
                <img src={d.compositeUrl} style={{ maxHeight: 360, maxWidth: '100%', borderRadius: 12, border: '1.5px solid var(--line)' }} />
              </a>
              <div className="grid" style={{ gap: 8 }}>
                <a className="btn" href={d.compositeUrl + '&download=1'}>
                  Download frame
                </a>
                {d.printFileUrl ? (
                  <a className="btn" href={d.printFileUrl} target="_blank" rel="noreferrer">
                    Open print file
                  </a>
                ) : null}
              </div>
            </div>
          ) : (
            <span className="mu">Not rendered yet</span>
          )}
        </div>
        <div className="card">
          <h2>Digital gallery</h2>
          {g ? (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div className="qr" dangerouslySetInnerHTML={{ __html: g.qrSvg }} />
              <div className="grid" style={{ gap: 6 }}>
                <a className="mono" href={g.url} target="_blank" rel="noreferrer">
                  {g.url}
                </a>
                <span className="small mu">Expires {dt(g.expiresAt)}</span>
                {d.uploads?.length ? (
                  <span className="small mu">
                    Cloud uploads: {d.uploads.filter((u: any) => u.status === 'DONE').length}/{d.uploads.length}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <span className="mu">No gallery yet</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Photos ({s.photos.length})</h2>
        <div className="photos">
          {s.photos.map((p: any) => (
            <figure key={p.id} style={{ opacity: p.selected ? 1 : 0.55 }}>
              <a href={d.originals[p.id]} target="_blank" rel="noreferrer">
                <img src={p.thumbUrl} loading="lazy" />
              </a>
              <figcaption>
                <span>
                  A{p.angle + 1}·{p.shot + 1}
                  {p.retaken ? ' ↻' : ''}
                  {p.superseded ? ' ✕' : ''}
                </span>
                <a href={d.originals[p.id] + '&download=1'}>↓</a>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className="grid g2">
        <div className="card tbl">
          <h2>Payments</h2>
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {d.payments.map((p: any) => (
                <tr key={p.id}>
                  <td className="mono">
                    {p.orderId}
                    <div className="small mu">{p.provider} · {p.providerTransactionId}</div>
                  </td>
                  <td>{statusChip(p.status)}</td>
                  <td>{rp(p.amount)}</td>
                  <td className="small">{dt(p.paidAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style={{ marginTop: 18 }}>Print jobs</h2>
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Copies</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {d.printJobs.map((j: any) => (
                <tr key={j.id}>
                  <td className="mono small">
                    {j.id.slice(-8)} {j.isReprint ? <span className="chip mu">reprint</span> : null}
                    {j.error ? <div style={{ color: 'var(--er)' }}>{j.error}</div> : null}
                  </td>
                  <td>{statusChip(j.status)}</td>
                  <td>{j.copies}</td>
                  <td>
                    {j.attempts}/{j.maxAttempts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Timeline</h2>
          <div className="timeline">
            <table>
              <tbody>
                {d.events.map((e: any) => (
                  <tr key={e.id}>
                    <td className="small mu" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(e.createdAt).toLocaleTimeString('id-ID')}
                    </td>
                    <td>
                      <b className="small">{e.event}</b>
                    </td>
                    <td className="small">{e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : e.data ? JSON.stringify(e.data).slice(0, 80) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
