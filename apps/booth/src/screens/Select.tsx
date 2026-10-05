import { currentTemplate, useBooth, useFlatPhotos } from '../store';
import { Frame } from '../components/Frame';
import { Icon, Pic } from '../components/basics';
import { autoPick, back, chooseTemplate, clearPicks, confirmPicks, confirmTemplate, togglePick } from '../flow';

/** prototype V.tpl */
export function Tpl() {
  const allTemplates = useBooth((s) => s.config!.templates);
  const tplId = useBooth((s) => currentTemplate(s).id);
  const flat = useFlatPhotos();
  const label = useBooth((s) => s.config!.branding.label);
  const busy = useBooth((s) => s.busy);
  // Only frames that can be filled with the session's photos (configurable capture plans).
  const fit = allTemplates.filter((t) => t.photoCount <= flat.length);
  const templates = fit.length ? fit : allTemplates;
  return (
    <div className="scr en">
      <div className="top">
        <button className={`btn sm ${busy === 'back' ? 'wait' : ''}`} onClick={back}>
          <Icon n="back" z={30} /> Kembali
        </button>
        <div className="chip b">Pilih frame</div>
      </div>
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {templates.map((t) => {
          const step = Math.max(1, Math.floor(flat.length / t.photoCount));
          const auto = [...Array(t.photoCount)].map((_, i) => flat[Math.min(flat.length - 1, i * step)]);
          const sel = tplId === t.id;
          return (
            <div
              key={t.id}
              className="card"
              data-tap=""
              data-testid={`tpl-${t.id}`}
              onClick={() => chooseTemplate(t.id)}
              style={{ padding: '22px 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', gap: 14, cursor: 'pointer', border: `8px solid ${sel ? 'var(--bl)' : 'transparent'}`, flex: 1, minWidth: 0 }}
            >
              <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                <Frame t={t} h={Math.min(440, 236 / t.aspectRatio)} mode={0} slots={auto} label={t.label || label} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, fontWeight: 600 }}>{t.name}</div>
                <div className={`chip ${sel ? 'b' : ''}`} style={{ height: 52, fontSize: 26, marginTop: 10 }}>
                  {t.photoCount} foto
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 26 }}>
        <button className={`btn pr ${busy === 'frame' ? 'wait' : ''}`} onClick={confirmTemplate} data-testid="tpl-next">
          PILIH FRAME <Icon n="next" z={36} />
        </button>
      </div>
    </div>
  );
}

/** prototype V.pick */
export function Pick() {
  const t = useBooth(currentTemplate);
  const flat = useFlatPhotos();
  const picks = useBooth((s) => s.picks);
  const photos = useBooth((s) => s.session!.photos);
  const label = useBooth((s) => s.config!.branding.label);
  const busy = useBooth((s) => s.busy);
  const n = t.photoCount;
  const k = picks.length;
  const slots = [...Array(n)].map((_, i) => photos.find((p) => p.id === picks[i]));
  return (
    <div className="scr en">
      <div className="top">
        <button className={`btn sm ${busy === 'back' ? 'wait' : ''}`} onClick={back}>
          <Icon n="back" z={30} />
          Kembali
        </button>
        <div className={`chip ${k == n ? 'y' : 'b'}`} data-testid="pick-count">
          ✓ {k} / {n} foto
        </div>
      </div>
      <div className="row" style={{ gap: 56, minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20, minHeight: 0 }}>
          <div>
            <h2>Pilih foto untuk dicetak</h2>
            <p className="p" style={{ fontSize: 32, marginTop: 6 }}>
              Ketuk {n} foto favoritmu. Urutannya mengikuti posisi di frame.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 14, alignContent: 'start', overflow: 'hidden' }}>
            {flat.map((p) => {
              const i = picks.indexOf(p.id);
              return (
                <div key={p.id} className={`th ${i >= 0 ? 'sel' : ''}`} data-n={i + 1} style={{ aspectRatio: '4/3' }} onClick={() => togglePick(p.id)} data-testid="pick-photo">
                  <Pic url={p.thumbUrl} />
                  <i className="tl">Sudut {p.angle + 1}</i>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ width: 520, display: 'flex', justifyContent: 'center' }}>
          <Frame t={t} h={660} mode={3} slots={slots} label={t.label || label} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <button className="btn sm" onClick={autoPick} data-testid="pick-auto">
            <Icon n="auto" z={30} /> Pilih otomatis
          </button>
          <button className="btn sm" onClick={clearPicks}>
            Hapus pilihan
          </button>
        </div>
        <button className={`btn pr ${busy === 'photos' ? 'wait' : ''}`} disabled={k != n} onClick={confirmPicks} data-testid="pick-next">
          LANJUT <Icon n="next" z={36} />
        </button>
      </div>
    </div>
  );
}

