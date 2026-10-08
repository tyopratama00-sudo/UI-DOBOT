import { useEffect, useRef, useState } from 'react';
import { priceFor, rp } from '@photobooth/shared';
import { useBooth } from '../store';
import { Bubble, Icon, QrCode, Robot } from '../components/basics';
import { backFromPay, retryPayment, setQty, simulateMockPayment } from '../flow';
import { puffs } from '../robot/floating';

type PayPhase = 'wait' | 'transitioning' | 'ok';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** prototype V.pay — quantity, price, real dynamic QRIS, payment states */
export function Pay() {
  const session = useBooth((s) => s.session)!;
  const qty = useBooth((s) => s.qty);
  const pricing = useBooth((s) => s.config!.pricing);
  const mockPayment = useBooth((s) => s.config!.mockPayment);
  const payBusy = useBooth((s) => s.payBusy);
  const payError = useBooth((s) => s.payError);
  const busy = useBooth((s) => s.busy);
  const now = useNow();
  const [phase, setPhase] = useState<PayPhase>('wait');
  const qrRef = useRef<HTMLDivElement>(null);
  const asapRef = useRef<HTMLDivElement>(null);
  const st = session.status;
  const pay: 'wait' | 'ok' | 'fail' = st === 'PAYMENT_SUCCESS' ? 'ok' : st === 'PAYMENT_FAILED' || (payError && !payBusy) ? 'fail' : 'wait';
  const payment = session.payment && session.payment.status === 'PENDING' ? session.payment : null;
  const qrReady = !!payment && payment.quantity === qty && !payBusy;
  const left = payment ? Math.max(0, Math.floor((new Date(payment.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = session.payment?.status === 'EXPIRED';

  useEffect(() => {
    if (pay === 'ok' && phase === 'wait') setPhase('transitioning');
  }, [pay, phase]);

  // Robot emerges from smoke inside the QR box: thick puffs cover it at once and
  // thin out, a second wave hugs the bottom so the feet clear last.
  useEffect(() => {
    if (phase !== 'transitioning') return;
    const el = asapRef.current;
    if (el) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      puffs(el, w, h, 11, { size: [w * 0.45, w * 0.7], drift: 0.25, spread: 0, life: 2300, cls: 'puff thick' });
      puffs(el, w, h, 8, { size: [w * 0.35, w * 0.55], y: [0.6, 0.95], drift: 0.3, spread: 0.6, life: 2300, cls: 'puff soft' });
    }
    const t = setTimeout(() => setPhase('ok'), 2400);
    return () => clearTimeout(t);
  }, [phase]);
  const done = phase !== 'wait';
  // Keep the QR mounted on the paid render before the effect flips phase (no flicker).
  const inQr = done || pay !== 'fail';

  return (
    <div className="scr en">
      <div className="top">
        <button className={`btn sm ${busy === 'cancel' ? 'wait' : ''}`} onClick={backFromPay} disabled={pay === 'ok'} data-testid="pay-back">
          <Icon n="back" z={30} />
          Kembali
        </button>
        <div className="chip b">Langkah 1 dari 4 · Bayar</div>
      </div>
      <div className="row">
        <div className="card" style={{ flex: 1.15, padding: 56, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', position: 'relative' }}>
          <div>
            <h2>Pilih jumlah cetakanmu</h2>
            <p className="p" style={{ marginTop: 10, maxWidth: 640 }}>
              Cetak pertama {rp(pricing.firstPrint)}, tambahan +{rp(pricing.additionalPrint)} per lembar
            </p>
          </div>
          <div className="qty" style={{ justifyContent: 'center' }}>
            <button className="btn rnd" onClick={() => setQty(-1)} disabled={qty <= 1 || pay === 'ok'} data-testid="qty-minus">
              −
            </button>
            <b data-testid="qty">{qty}</b>
            <button className="btn rnd" onClick={() => setQty(1)} disabled={qty >= pricing.maxQuantity || pay === 'ok'} data-testid="qty-plus">
              +
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div className="p">Total</div>
              <div style={{ fontSize: 110, fontWeight: 700, lineHeight: 1, color: 'var(--bl)' }} data-testid="total">
                {rp(priceFor(qty, pricing))}
              </div>
            </div>
          </div>
        </div>
        <div className="card" style={{ flex: 0.85, padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', textAlign: 'center', position: 'relative' }}>
          {inQr ? (
            <>
              {done ? (
                <div className="pill s" data-testid="pay-ok">
                  <Icon n="check" z={34} /> Pembayaran berhasil
                </div>
              ) : (
                <div className="pill w" data-testid="pay-waiting">
                  <Icon n="clock" z={34} /> Menunggu pembayaran
                  {qrReady && left > 0 ? (
                    <span className="tm">
                      · {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
                    </span>
                  ) : null}
                </div>
              )}
              <div ref={qrRef} className={`qrbox ${qrReady || done ? '' : 'busy'}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, border: '6px solid var(--soft)', borderRadius: 32, position: 'relative' }} data-testid="qris">
                <div className={`qrin ${done ? 'gone' : ''}`}>
                  {payment || done ? <QrCode text={payment?.qrString ?? session.payment?.qrString ?? ''} size={360} level="Q" /> : <div className="qrskel" />}
                </div>
                <div className={`qrin ${done ? 'gone' : ''}`} style={{ position: 'absolute', left: '50%', top: '50%', translate: '-50% -50%', background: '#fff', borderRadius: 20, padding: '4px 12px', fontWeight: 700, fontSize: 30 }}>
                  QRIS
                </div>
                {/* layers: robot < fog < smoke, so the smoke covers the robot */}
                {done ? (
                  <>
                    <div className="emerge">
                      <Robot m="cheer" s={330} />
                    </div>
                    <div className="fog" />
                    <div ref={asapRef} className="asap" />
                  </>
                ) : null}
              </div>
              {done ? (
                <div className="late">
                  <h2>Lunas</h2>
                  <p className="p" style={{ marginTop: 8 }}>
                    Kita mulai sebentar lagi.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
                  <p className="p" style={{ fontSize: 32 }}>
                    Scan dengan e-wallet atau m-banking
                  </p>
                  {mockPayment ? (
                    <button
                      className={`btn ${payBusy ? 'wait' : ''}`}
                      style={{ height: 110, fontSize: 38, background: 'var(--lv)', color: 'var(--ink)', minWidth: 340 }}
                      onClick={() => void simulateMockPayment()}
                      data-testid="bayar-sekarang"
                    >
                      BAYAR SEKARANG
                    </button>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="pill f" data-testid="pay-failed">
                <Icon n="x" z={34} /> Pembayaran gagal
              </div>
              <Robot m="think" s={260} />
              <Bubble>{payError ?? (expired ? 'Waktu pembayaran habis. Yuk buat kode QR baru.' : 'Oops! Pembayaran belum berhasil. Yuk coba lagi.')}</Bubble>
              <button className={`btn pr ${busy === 'retry-pay' ? 'wait' : ''}`} onClick={retryPayment} data-testid="pay-retry">
                Coba lagi
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
