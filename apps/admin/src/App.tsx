import { useEffect, useState } from 'react';
import { robotSvg } from '@photobooth/ui';
import { get, post, setUnauthorizedHandler } from './api';
import { Dashboard } from './pages/Dashboard';
import { Sessions, SessionDetail } from './pages/Sessions';
import { PrintQueue } from './pages/PrintQueue';
import { Configuration } from './pages/Configuration';
import { Diagnostics } from './pages/Diagnostics';
import { Logs } from './pages/Logs';
import { Toasts } from './ui';

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

function Login({ onDone }: { onDone: (u: string) => void }) {
  const [username, setU] = useState('admin');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await post<{ username: string }>('/api/admin/login', { username, password });
      onDone(r.username);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div style={{ display: 'flex', justifyContent: 'center' }} dangerouslySetInnerHTML={{ __html: robotSvg('hi', 120) }} />
        <h1 style={{ textAlign: 'center', margin: 0 }}>Admin Login</h1>
        <p className="mu" style={{ textAlign: 'center', margin: 0 }}>
          Robot Photobooth control panel
        </p>
        <label className="f">
          Username
          <input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" data-testid="login-user" />
        </label>
        <label className="f">
          Password
          <input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" data-testid="login-pass" />
        </label>
        {err ? <div className="chip err">{err}</div> : null}
        <button className="btn pr" disabled={busy} data-testid="login-submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const NAV: [string, string][] = [
  ['/', 'Dashboard'],
  ['/sessions', 'Sessions'],
  ['/print', 'Print queue'],
  ['/config', 'Configuration'],
  ['/diagnostics', 'Diagnostics'],
  ['/logs', 'Logs'],
];

export function App() {
  const route = useHashRoute();
  const [user, setUser] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get<{ authenticated: boolean; username: string | null }>('/api/admin/session')
      .then((r) => setUser(r.authenticated ? r.username : null))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return null;
  if (!user) return <Login onDone={setUser} />;

  const logout = async () => {
    await post('/api/admin/logout');
    setUser(null);
  };

  let page: JSX.Element;
  const m = route.match(/^\/sessions\/([^/]+)$/);
  if (m) page = <SessionDetail id={m[1]} />;
  else if (route.startsWith('/sessions')) page = <Sessions />;
  else if (route.startsWith('/print')) page = <PrintQueue />;
  else if (route.startsWith('/config')) page = <Configuration />;
  else if (route.startsWith('/diagnostics')) page = <Diagnostics />;
  else if (route.startsWith('/logs')) page = <Logs />;
  else page = <Dashboard />;

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <span dangerouslySetInnerHTML={{ __html: robotSvg('hi', 44) }} />
          Robot
          <br />
          Photobooth
        </div>
        <nav className="nav">
          {NAV.map(([href, label]) => (
            <a key={href} href={`#${href}`} className={(href === '/' ? route === '/' : route.startsWith(href)) ? 'on' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <a className="small" href="/" target="_blank" rel="noreferrer">
          Open booth ↗
        </a>
        <div className="small mu">Signed in as {user}</div>
        <button className="btn" onClick={logout}>
          Sign out
        </button>
      </aside>
      <main>{page}</main>
      <Toasts />
    </div>
  );
}
