import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { angleConfigSchema, CAMERA_DRIVERS, computeFrameLayout, PRINTER_DRIVERS, ROBOT_DRIVERS, templatesSchema, type PhotoTemplate } from '@photobooth/shared';
import { del, get, put } from '../api';
import { toast, usePoll } from '../ui';

const ENUMS: Record<string, readonly (string | number)[]> = {
  'camera.driver': CAMERA_DRIVERS,
  'camera.previewFit': ['cover', 'contain'],
  'camera.previewRotation': [0, 90, 180, 270],
  'camera.captureRotation': [0, 90, 180, 270],
  'printer.driver': PRINTER_DRIVERS,
  'printer.format': ['jpeg', 'png'],
  'robot.driver': ROBOT_DRIVERS,
};

const TITLES: Record<string, [string, string]> = {
  pricing: ['Pricing', 'Prices in IDR. First print + each additional print.'],
  session: ['Photo session', 'Angles, shots per angle, countdown and retake limit (applies to new sessions).'],
  timeouts: ['Timeouts', 'Inactivity limits per screen in seconds. Unpaid sessions are cancelled; paid sessions are auto-completed.'],
  camera: ['Camera', 'Driver and live-view options. webcam = browser getUserMedia on the booth.'],
  printer: ['Printer', 'Print size in pixels at the given DPI (1200×1800 = 4×6" @ 300 DPI).'],
  robot: ['Robot', 'Physical robot connection. Positions per angle are under "Angles".'],
  gallery: ['Gallery', 'Digital gallery link lifetime.'],
  payment: ['Payment', 'QRIS validity. Provider and keys are configured in the server .env.'],
  branding: ['Branding', 'Texts printed on frames and shown on the welcome screen.'],
  dev: ['Development', 'Ignored in production builds.'],
};

const human = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function Configuration() {
  const [data, reload] = usePoll<any>(() => get('/api/admin/settings'));
  const [tab, setTab] = useState('pricing');
  if (!data) return <div className="mu">Loading…</div>;
  const sections: string[] = data.sections;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Configuration</h1>
      <div className="card btns">
        {sections.map((s) => (
          <button key={s} className={`btn ${tab === s ? 'pr' : ''}`} onClick={() => setTab(s)}>
            {TITLES[s]?.[0] ?? human(s)} {data.overridden.includes(s) ? '•' : ''}
          </button>
        ))}
      </div>
      <div className="card small mu">
        Environment: <b>{data.environment.nodeEnv}</b> · payment <b>{data.environment.paymentProvider}</b> · storage <b>{data.environment.storageProvider}</b> ({data.environment.storagePath}) · gallery{' '}
        <b>{data.environment.galleryMode}</b> → {data.environment.galleryBaseUrl} · critical: {data.environment.criticalComponents.join(', ')}
      </div>
      {tab === 'templates' ? (
        <JsonSection key={tab} section={tab} value={data.settings.templates} overridden={data.overridden.includes(tab)} onSaved={reload} schema={templatesSchema} preview={(v) => <TemplatePreview list={v as PhotoTemplate[]} />} />
      ) : tab === 'angles' ? (
        <JsonSection key={tab} section={tab} value={data.settings.angles} overridden={data.overridden.includes(tab)} onSaved={reload} schema={z.array(angleConfigSchema).min(1)} />
      ) : (
        <FormSection key={tab} section={tab} value={data.settings[tab]} defaults={data.defaults[tab]} overridden={data.overridden.includes(tab)} onSaved={reload} />
      )}
    </div>
  );
}

function FormSection({ section, value, defaults, overridden, onSaved }: { section: string; value: Record<string, any>; defaults: Record<string, any>; overridden: boolean; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, any>>(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(value), [value]);
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  const save = async () => {
    setSaving(true);
    try {
      await put(`/api/admin/settings/${section}`, { value: v });
      toast('Saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    if (!confirm('Reset this section to the .env / built-in defaults?')) return;
    await del(`/api/admin/settings/${section}`);
    toast('Reset to defaults');
    onSaved();
  };
  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{TITLES[section]?.[0] ?? human(section)}</h2>
        {overridden ? <span className="chip warn">overridden in admin</span> : <span className="chip mu">.env defaults</span>}
      </div>
      <p className="mu small">{TITLES[section]?.[1]}</p>
      <div className="grid g3">
        {Object.entries(v).map(([k, val]) => {
          const key = `${section}.${k}`;
          const def = defaults?.[k];
          const label = (
            <span>
              {human(k)} {JSON.stringify(def) !== JSON.stringify(val) ? <span className="mu">(default {String(def)})</span> : null}
            </span>
          );
          if (ENUMS[key])
            return (
              <label key={k} className="f">
                {label}
                <select value={String(val)} onChange={(e) => setV({ ...v, [k]: typeof val === 'number' ? Number(e.target.value) : e.target.value })}>
                  {ENUMS[key].map((o) => (
                    <option key={String(o)} value={String(o)}>
                      {String(o)}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (typeof val === 'boolean')
            return (
              <label key={k} className="chk">
                <input type="checkbox" checked={val} onChange={(e) => setV({ ...v, [k]: e.target.checked })} />
                {label}
              </label>
            );
          if (typeof val === 'number')
            return (
              <label key={k} className="f">
                {label}
                <input type="number" step="any" value={val} onChange={(e) => setV({ ...v, [k]: e.target.value === '' ? 0 : Number(e.target.value) })} />
              </label>
            );
          return (
            <label key={k} className="f">
              {label}
              <input value={val ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
            </label>
          );
        })}
      </div>
      <div className="btns" style={{ marginTop: 16 }}>
        <button className="btn pr" disabled={!dirty || saving} onClick={save} data-testid="settings-save">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setV(value)}>
          Discard
        </button>
        <button className="btn er" disabled={!overridden} onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function JsonSection({ section, value, overridden, onSaved, schema, preview }: { section: string; value: unknown; overridden: boolean; onSaved: () => void; schema: z.ZodTypeAny; preview?: (v: unknown) => JSX.Element }) {
  const initial = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  let parsed: unknown = null;
  let error = '';
  try {
    const r = schema.safeParse(JSON.parse(text));
    if (r.success) parsed = r.data;
    else error = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  } catch (e) {
    error = (e as Error).message;
  }
  const save = async () => {
    try {
      await put(`/api/admin/settings/${section}`, { value: parsed });
      toast('Saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="grid g2">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>{section === 'templates' ? 'Frame templates' : 'Robot angles'}</h2>
          {overridden ? <span className="chip warn">overridden in admin</span> : <span className="chip mu">defaults</span>}
        </div>
        <p className="mu small">
          {section === 'templates'
            ? 'Add, disable or edit frames without touching code. Fields: id, name, photoCount, columns, rows, aspectRatio (w/h), background, slotStyle (rounded|polaroid|square), label, labelColor, enabled, reaction.'
            : 'Physical positions for each angle id. "position" is forwarded verbatim to the robot controller; settleMs waits after arrival.'}
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        {error ? <pre className="chip err" style={{ whiteSpace: 'pre-wrap', borderRadius: 12, padding: 10 }}>{error}</pre> : null}
        <div className="btns" style={{ marginTop: 12 }}>
          <button className="btn pr" disabled={!!error || text === initial} onClick={save}>
            Save
          </button>
          <button className="btn" disabled={text === initial} onClick={() => setText(initial)}>
            Discard
          </button>
          <button className="btn er" disabled={!overridden} onClick={async () => (await del(`/api/admin/settings/${section}`), toast('Reset'), onSaved())}>
            Reset to defaults
          </button>
        </div>
      </div>
      {preview && parsed ? (
        <div className="card">
          <h2>Preview</h2>
          {preview(parsed)}
        </div>
      ) : null}
    </div>
  );
}

function TemplatePreview({ list }: { list: PhotoTemplate[] }) {
  return (
    <div className="preview-frames">
      {list.map((t) => {
        const L = computeFrameLayout(t, 240);
        return (
          <div key={t.id} style={{ textAlign: 'center', opacity: t.enabled ? 1 : 0.4 }}>
            <div style={{ position: 'relative', width: L.width, height: L.height, background: t.background, borderRadius: 8, boxShadow: '0 10px 20px -14px rgba(43,42,76,.5)' }}>
              {L.slots.map((r, i) => (
                <div
                  key={i}
                  style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: L.slotRadius, background: 'rgba(43,42,76,.18)', boxShadow: L.ring ? `0 0 0 ${L.ring}px #fff` : undefined }}
                />
              ))}
              <div style={{ position: 'absolute', left: L.label.x, top: L.label.y, width: L.label.w, height: L.label.h, fontSize: L.label.fontSize, letterSpacing: '.16em', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', color: t.labelColor }}>
                {t.label}
              </div>
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              {t.name} · {t.photoCount}
            </div>
          </div>
        );
      })}
    </div>
  );
}
