import { useState } from 'react';
import { dt, get } from '../api';
import { statusChip, usePoll } from '../ui';

export function Logs() {
  const [device, setDevice] = useState('');
  const [level, setLevel] = useState('');
  const [tab, setTab] = useState<'events' | 'webhooks'>('events');
  const [events] = usePoll<any[]>(() => get(`/api/admin/events?take=300${device ? `&device=${device}` : ''}${level ? `&level=${level}` : ''}`), 8000, [device, level]);
  const [hooks] = usePoll<any[]>(() => get('/api/admin/webhooks'), 15000);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Logs</h1>
      <div className="card row">
        <button className={`btn ${tab === 'events' ? 'pr' : ''}`} onClick={() => setTab('events')}>
          Device events
        </button>
        <button className={`btn ${tab === 'webhooks' ? 'pr' : ''}`} onClick={() => setTab('webhooks')}>
          Payment webhooks
        </button>
        <div className="spacer" />
        {tab === 'events' ? (
          <>
            <select value={device} onChange={(e) => setDevice(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">All devices</option>
              {['camera', 'robot', 'printer', 'payment', 'storage', 'internet', 'system', 'booth'].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ maxWidth: 160 }}>
              <option value="">All levels</option>
              {['INFO', 'WARN', 'ERROR'].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      <div className="card tbl">
        {tab === 'events' ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Device</th>
                <th>Event</th>
                <th>Message</th>
                <th>Session</th>
              </tr>
            </thead>
            <tbody>
              {events?.map((e) => (
                <tr key={e.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>
                    {dt(e.createdAt)}
                  </td>
                  <td>{statusChip(e.level)}</td>
                  <td>{e.device}</td>
                  <td className="mono">{e.event}</td>
                  <td className="small">{e.message}</td>
                  <td>{e.sessionId ? <a href={`#/sessions/${e.sessionId}`}>open</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Provider</th>
                <th>Order</th>
                <th>Signature</th>
                <th>Processed</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {hooks?.map((h) => (
                <tr key={h.id}>
                  <td className="small">{dt(h.createdAt)}</td>
                  <td>{h.provider}</td>
                  <td className="mono">{h.orderId}</td>
                  <td>{h.signatureValid ? <span className="chip ok">valid</span> : <span className="chip err">invalid</span>}</td>
                  <td>{h.processed ? 'yes' : 'no'}</td>
                  <td className="small">{h.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mu small">Full structured JSON logs are written to the server log directory (LOG_DIR, one file per day).</p>
      </div>
    </div>
  );
}
