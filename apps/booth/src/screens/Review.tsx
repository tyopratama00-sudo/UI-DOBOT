import { p2, retakesLeft } from '@photobooth/shared';
import { flatPhotos, useBooth } from '../store';
import { Icon, Pic } from '../components/basics';
import { closeLightbox, retake, tapReviewPhoto, toFrames } from '../flow';

/** prototype V.review */
export function Review() {
  const session = useBooth((s) => s.session)!;
  const busy = useBooth((s) => s.busy);
  const flatCount = useBooth((s) => flatPhotos(s).length);
  const { angles, shotsPerAngle, retakeLimit } = session.plan;
  const left = retakesLeft(session.retakenAngles, retakeLimit);
  const cols = angles > 10 ? Math.ceil(angles / 2) : Math.min(5, angles);
  const rows = Math.ceil(angles / cols);
  return (
    <div className="scr en" style={{ paddingTop: 40, paddingBottom: 36 }}>
      <div className="top" style={{ height: 90, marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 52 }}>Momen manismu ✨</h2>
          <div className="p" style={{ fontSize: 30, marginTop: 8 }}>
            Ketuk foto untuk melihat lebih dekat · pilih {shotsPerAngle} foto terbaik per sudut.
          </div>
        </div>
        <div className={`chip ${left ? 'y' : ''}`} data-testid="retakes-left">
          {left ? `♡ ${left} kesempatan ulang` : '✓ Semua kesempatan dipakai'}
        </div>
      </div>
      <div className="g5" style={{ flex: 1, gridTemplateColumns: `repeat(${cols},1fr)`, gridTemplateRows: `repeat(${rows},1fr)`, minHeight: 0 }}>
        {[...Array(angles)].map((_, a) => {
          const ps = session.photos.filter((p) => p.angle === a).sort((x, y) => x.shot - y.shot);
          const m = ps.length > shotsPerAngle;
          return (
            <div key={a} className={`card review-card ${m ? 'review-picking' : ''}`} style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12, borderRadius: 30, minHeight: 0 }} data-testid={`review-angle-${a}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 30, fontWeight: 600, gap: 8 }}>
                <span>♡ Sudut {p2(a + 1)}</span>
                {m ? (
                  <span style={{ color: 'var(--bl)', fontSize: 24 }}>
                    pilih {shotsPerAngle} dari {ps.length}
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(2, shotsPerAngle)},1fr)`, gap: 10, flex: 1, alignContent: 'center' }}>
                {ps.map((p) => (
                  <div key={p.id} className={`th review-photo ${m && p.selected ? 'sel' : ''}`} style={{ aspectRatio: '4/3', borderWidth: 4 }} onClick={() => tapReviewPhoto(a, p.id)} aria-label={`Sudut ${a + 1}, foto ${p.shot}`}>
                    <Pic url={p.thumbUrl} />
                    {m && p.selected ? <span className="review-selected">Pilihan</span> : null}
                  </div>
                ))}
              </div>
              {session.retakenAngles.includes(a) || !left ? null : (
                <button className="btn sm review-retake" style={{ height: 60, fontSize: 26 }} onClick={() => retake(a)} data-testid={`retake-${a}`}>
                  <Icon n="rot" z={26} /> Coba sudut ini lagi
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div className="p" style={{ fontSize: 28 }}>
          ✨ {flatCount} foto dipilih · semua momen tetap tersimpan
        </div>
        <button className={`btn pr ${busy === 'frames' ? 'wait' : ''}`} onClick={toFrames} data-testid="review-next">
          LANJUT <Icon n="next" z={36} />
        </button>
      </div>
    </div>
  );
}

/** Review photo enlarged (prototype S.big overlay) */
export function Lightbox() {
  const big = useBooth((s) => s.big);
  const photo = useBooth((s) => s.session?.photos.find((p) => p.id === s.big));
  if (!big || !photo) return null;
  return (
    <div className="lbx" onClick={closeLightbox} data-testid="lightbox">
      <div className="big">
        <Pic url={photo.previewUrl} />
      </div>
      <div className="btn" style={{ position: 'absolute', right: 80, top: 60 }}>
        <Icon n="x" z={36} /> Tutup
      </div>
    </div>
  );
}
