import { useRef, useState } from 'react';
import { get, post } from '../api';
import { healthDot, useAction, usePoll } from '../ui';

const LABEL: Record<string, string> = { camera: 'Camera', robot: 'Robot', printer: 'Printer', payment: 'Payment API', storage: 'Storage', internet: 'Internet', database: 'Database', server: 'Server' };
const WORD: Record<string, Record<string, string>> = {
  camera: { ok: 'Connected', down: 'Disconnected' },
  robot: { ok: 'Connected', down: 'Disconnected' },
  printer: { ok: 'Ready', down: 'Not ready' },
  payment: { ok: 'Connected', down: 'Unavailable' },
  storage: { ok: 'Ready', down: 'Unavailable' },
  internet: { ok: 'Online', down: 'Offline' },
  database: { ok: 'Connected', down: 'Down' },
  server: { ok: 'Running' },
};

interface Result {
  at: string;
  action: string;
  ok: boolean;
  message: string;
  ms?: number;
  imageUrl?: string;
  qrSvg?: string;
}

export function Diagnostics() {
  const [d, reload] = usePoll<any>(() => get('/api/admin/diagnostics'), 8000);
  const [angle, setAngle] = useState(1);
  const [results, setResults] = useState<Result[]>([]);
  const { busy, run } = useAction();

  const test = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = (await run(action, () => post('/api/admin/diagnostics/test', { action, ...extra }))) as Result | null;
    if (r) setResults((l) => [{ ...r, action, at: new Date().toLocaleTimeString('id-ID') }, ...l].slice(0, 20));
    void reload();
  };
  const mock = async (target: string, action: string) => {
    await run(`${target}:${action}`, () => post('/api/admin/mock', { target, action }));
    setTimeout(() => void reload(), 600);
  };

  if (!d) return <div className="mu">Loading…</div>;
  const comps = d.health.components;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Diagnostics</h1>
        <div className="spacer" />
        {d.health.acceptingSessions ? <span className="chip ok">Booth accepting payments</span> : <span className="chip err">New payments blocked</span>}
        <button className="btn" onClick={() => void reload()}>
          Refresh
        </button>
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>Status</h2>
          {Object.entries(comps).map(([k, c]: [string, any]) => (
            <div key={k} className="status-row" data-testid={`diag-${k}`}>
              <div className="row" style={{ gap: 8 }}>
                {healthDot(c.status)}
                <b>
                  {LABEL[k] ?? k}: {WORD[k]?.[c.status] ?? c.status}
                </b>
              </div>
              <span className="small mu" style={{ textAlign: 'right' }}>
                {c.message}
              </span>
            </div>
          ))}
          <div className="small mu" style={{ marginTop: 10 }}>
            Camera driver <b>{d.camera.driver}</b> · robot <b>{d.robot.driver}</b> ({d.robot.state}
            {d.robot.angle ? `, angle ${d.robot.angle}` : ''}) · printer <b>{d.printer.driver}</b> “{d.printer.name}” ({d.printer.state}) · payment <b>{d.payment.provider}</b>
          </div>
        </div>
        <div className="card">
          <h2>Hardware tests</h2>
          <div className="btns">
            <button className="btn" disabled={!!busy} onClick={() => test('camera_connect')}>
              Test Camera
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('camera_capture')}>
              Capture Test
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('robot_home')}>
              Home Robot
            </button>
            <select value={angle} onChange={(e) => setAngle(Number(e.target.value))} style={{ width: 'auto', minWidth: 160 }}>
              {d.angles.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.id}. {a.name}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!!busy} onClick={() => test('robot_move', { angle })}>
              Move Robot
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('robot_stop')}>
              Stop Robot
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('printer_test')}>
              Print Test
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('payment_test')}>
              Payment Test
            </button>
            <button className="btn" disabled={!!busy} onClick={() => test('storage_test')}>
              Storage Test
            </button>
          </div>
          {d.camera.driver === 'webcam' ? <WebcamTest /> : null}
          <div className="grid result" style={{ gap: 8, marginTop: 14 }}>
            {results.map((r, i) => (
              <div key={i} className="card" style={{ padding: 12 }}>
                <div className="row">
                  <span className={`chip ${r.ok ? 'ok' : 'err'}`}>{r.ok ? 'OK' : 'FAIL'}</span>
                  <b>{r.action}</b>
                  <span className="mu small">
                    {r.at} · {r.ms}ms
                  </span>
                </div>
                <div className="small">{r.message}</div>
                {r.imageUrl ? <img src={r.imageUrl} /> : null}
                {r.qrSvg ? <div className="qr" dangerouslySetInnerHTML={{ __html: r.qrSvg }} /> : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Mock controls</h2>
        <p className="mu small">Only active for mock drivers. Use them to rehearse failure handling without hardware.</p>
        <div className="grid g2">
          <div>
            <h3>Payment {d.mock.payment ? '' : <span className="chip mu">not mock</span>}</h3>
            <div className="btns">
              <button className="btn pr" disabled={!d.mock.payment} onClick={() => mock('payment', 'success')} data-testid="mock-pay-success">
                Simulate Payment Success
              </button>
              <button className="btn er" disabled={!d.mock.payment} onClick={() => mock('payment', 'failed')}>
                Simulate Payment Failed
              </button>
              <button className="btn" disabled={!d.mock.payment} onClick={() => mock('payment', 'expired')}>
                Simulate Payment Expired
              </button>
              <button className="btn" disabled={!d.mock.payment} onClick={() => mock('payment', 'unavailable')}>
                Payment API down
              </button>
              <button className="btn" disabled={!d.mock.payment} onClick={() => mock('payment', 'available')}>
                Payment API up
              </button>
            </div>
          </div>
          <div>
            <h3>Camera</h3>
            <div className="btns">
              <button className="btn er" disabled={!d.mock.camera} onClick={() => mock('camera', 'capture_failure')}>
                Simulate Camera Failure
              </button>
              <button className="btn er" disabled={!d.mock.camera} onClick={() => mock('camera', 'disconnect')}>
                Simulate Disconnect
              </button>
              <button className="btn" disabled={!d.mock.camera} onClick={() => mock('camera', 'clear')}>
                Clear
              </button>
              {d.camera.injectedFault ? <span className="chip warn">booth webcam fault: {d.camera.injectedFault}</span> : null}
            </div>
          </div>
          <div>
            <h3>Robot {d.mock.robot ? '' : <span className="chip mu">not mock</span>}</h3>
            <div className="btns">
              <button className="btn er" disabled={!d.mock.robot} onClick={() => mock('robot', 'timeout')}>
                Simulate Robot Timeout
              </button>
              <button className="btn er" disabled={!d.mock.robot} onClick={() => mock('robot', 'disconnected')}>
                Simulate Robot Disconnected
              </button>
              <button className="btn" disabled={!d.mock.robot} onClick={() => mock('robot', 'clear')}>
                Clear
              </button>
            </div>
          </div>
          <div>
            <h3>Printer {d.mock.printer ? '' : <span className="chip mu">not mock</span>} {d.mock.printerFault ? <span className="chip warn">{d.mock.printerFault}</span> : null}</h3>
            <div className="btns">
              <button className="btn er" disabled={!d.mock.printer} onClick={() => mock('printer', 'offline')}>
                Simulate Printer Offline
              </button>
              <button className="btn er" disabled={!d.mock.printer} onClick={() => mock('printer', 'paper_out')}>
                Paper Empty
              </button>
              <button className="btn er" disabled={!d.mock.printer} onClick={() => mock('printer', 'ink_error')}>
                Ink / Ribbon Error
              </button>
              <button className="btn er" disabled={!d.mock.printer} onClick={() => mock('printer', 'fail_next')}>
                Fail Next Job
              </button>
              <button className="btn" disabled={!d.mock.printer} onClick={() => mock('printer', 'clear')}>
                Clear
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Installed printers</h2>
          {d.printers.length ? (
            <ul>
              {d.printers.map((p: string) => (
                <li key={p} className="mono">
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <span className="mu small">None detected (or not available on this OS).</span>
          )}
        </div>
        <div className="card">
          <h2>Server</h2>
          <div className="small">
            Node {d.process.node} · {d.process.platform} · uptime {Math.round(d.process.uptime / 60)} min · memory {Math.round(d.process.memory / 1024 / 1024)} MB
          </div>
          {d.camera.browser ? (
            <div className="small" style={{ marginTop: 8 }}>
              Booth heartbeat: camera <b>{d.camera.browser.state}</b> {d.camera.browser.model} · screen {d.camera.browser.screen} · {new Date(d.camera.browser.reportedAt).toLocaleTimeString('id-ID')}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Webcam check from the admin browser (useful when the admin runs on the booth PC). */
function WebcamTest() {
  const video = useRef<HTMLVideoElement>(null);
  const [img, setImg] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      setMsg(`${s.getVideoTracks()[0].label} · ${devices.length} camera(s): ${devices.map((d) => `${d.label} [${d.deviceId.slice(0, 8)}…]`).join(', ')}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const snap = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    setImg(c.toDataURL('image/jpeg', 0.9));
    setMsg(`Captured ${v.videoWidth}×${v.videoHeight}`);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="btns">
        <button className="btn" onClick={start}>
          Test webcam in this browser
        </button>
        <button className="btn" onClick={snap}>
          Snapshot
        </button>
      </div>
      <div className="small mu">{msg}</div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <video ref={video} muted playsInline style={{ width: 240, borderRadius: 12, background: '#000' }} />
        {img ? <img src={img} style={{ width: 240, borderRadius: 12 }} /> : null}
      </div>
    </div>
  );
}
