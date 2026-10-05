import { ago, get, rp } from '../api';
import { healthDot, statusChip, usePoll } from '../ui';

const COMPONENT_LABELS: Record<string, string> = {
  camera: 'Camera',
  robot: 'Robot',
  printer: 'Printer',
  payment: 'Payment API',
  storage: 'Storage',
  internet: 'Internet',
  database: 'Database',
  server: 'Server',
};

export function Dashboard() {
  const [d, , err] = usePoll<any>(() => get('/api/admin/dashboard'), 10000);
  if (!d) return <div className="mu">{err ?? 'Loading…'}</div>;
  const hourNow = new Date().getHours();
  const max = Math.max(1, ...d.hourly.map((h: any) => h.revenue));
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Dashboard</h1>
        <div className="spacer" />
        {d.health.acceptingSessions ? <span className="chip ok">Accepting customers</span> : <span className="chip err">Maintenance mode (critical component down)</span>}
      </div>
      <div className="grid g6">
        <Kpi l="Sessions today" v={d.today.sessions} />
        <Kpi l="Revenue today" v={rp(d.today.revenue)} />
        <Kpi l="Photos taken" v={d.today.photos} />
        <Kpi l="Completed" v={d.today.completed} />
        <Kpi l="Failed" v={d.today.failed} warn={d.today.failed > 0} />
        <Kpi l="Refunds to review" v={d.refundsToReview} warn={d.refundsToReview > 0} />
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>System status</h2>
          {Object.entries(d.health.components).map(([k, c]: [string, any]) => (
            <div key={k} className="status-row">
              <div className="row" style={{ gap: 8 }}>
                {healthDot(c.status)}
                <b>{COMPONENT_LABELS[k] ?? k}</b>
                {c.critical ? <span className="chip mu">critical</span> : null}
              </div>
              <span className="mu small" style={{ textAlign: 'right' }}>
                {c.message}
              </span>
            </div>
          ))}
          <div className="row small mu" style={{ marginTop: 8 }}>
            Print queue: {Object.entries(d.printQueue).map(([k, v]) => `${k} ${v}`).join(' · ') || 'empty'} · Uploads pending: {d.uploadsPending}
          </div>
        </div>
        <div className="card">
          <h2>Revenue by hour (today)</h2>
          <div className="bars">
            {d.hourly.map((h: any, i: number) => (
              <div key={i} className={i === hourNow ? 'cur' : ''} style={{ height: `${(h.revenue / max) * 100}%` }} title={`${i}:00 · ${h.sessions} paid · ${rp(h.revenue)}`} />
            ))}
          </div>
          <div className="row small mu" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>23</span>
          </div>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>Recent sessions</h2>
          <div className="tbl">
            <table>
              <tbody>
                {d.recentSessions.map((s: any) => (
                  <tr key={s.id} className="click" onClick={() => (location.hash = `#/sessions/${s.id}`)}>
                    <td className="mono">{s.sessionCode}</td>
                    <td>{statusChip(s.status)}</td>
                    <td>{s.paidAt ? rp(s.amount) : <span className="mu">unpaid</span>}</td>
                    <td className="mu small">{ago(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>Hardware & integration events</h2>
          <div className="tbl">
            <table>
              <tbody>
                {d.recentEvents.map((e: any) => (
                  <tr key={e.id}>
                    <td>{statusChip(e.level)}</td>
                    <td>
                      <b>{e.device}</b> <span className="mu small">{e.event}</span>
                      <div className="small">{e.message}</div>
                    </td>
                    <td className="mu small">{ago(e.createdAt)}</td>
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

function Kpi({ l, v, warn }: { l: string; v: string | number; warn?: boolean }) {
  return (
    <div className="card kpi" style={warn ? { borderColor: 'rgba(240,86,74,.4)' } : undefined}>
      <div className="l">{l}</div>
      <div className="v" style={warn ? { color: 'var(--er)' } : undefined}>
        {v}
      </div>
    </div>
  );
}
