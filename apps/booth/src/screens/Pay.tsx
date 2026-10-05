import { useEffect, useRef, useState } from 'react';
import { priceFor, rp } from '@photobooth/shared';
import { useBooth } from '../store';
import { Bubble, Icon, QrCode, Robot } from '../components/basics';
import { puffs } from '../robot/floating';
import { backFromPay, retryPayment, setQty } from '../flow';

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
  const payBusy = useBooth((s) => s.payBusy);
  const payError = useBooth((s) => s.payError);
  const busy = useBooth((s) => s.busy);
  const now = useNow();
  const pr = useRef<HTMLDivElement>(null);
  const [appear, setAppear] = useState(true);

  const st = session.status;
  const pay: 'wait' | 'ok' | 'fail' = st === 'PAYMENT_SUCCESS' ? 'ok' : st === 'PAYMENT_FAILED' || (payError && !payBusy) ? 'fail' : 'wait';
  const payment = session.payment && session.payment.status === 'PENDING' ? session.payment : null;
  const qrReady = !!payment && payment.quantity === qty && !payBusy;
  const left = payment ? Math.max(0, Math.floor((new Date(payment.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = session.payment?.status === 'EXPIRED';

  // prototype ninjaIn(): the robot pops in with smoke puffs
  useEffect(() => {
    puffs(pr.current, 170, 180, 6);
    const a = setTimeout(() => puffs(pr.current, 170, 180, 4), 300);
    const b = setTimeout(() => setAppear(false), 1300);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, []);

  const failText = payError ?? (expired ? 'Waktu pembayaran habis. Yuk buat kode QR baru.' : 'Oops! Pembayaran belum berhasil. Yuk coba lagi.');

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
          {pay === 'wait' ? (
            <div id="pr" ref={pr} style={{ position: 'absolute', right: 36, top: 34, width: 170, height: 180 }}>
              <div className={appear ? 'appear' : ''}>
                <Robot m="hi" s={170} />
              </div>
            </div>
          ) : null}
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
        <div className="card" style={{ flex: 0.85, padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', textAlign: 'center' }}>
          {pay === 'wait' ? (
            <>
              <div className="pill w" data-testid="pay-waiting">
                <Icon n="clock" z={34} /> Menunggu pembayaran
                {qrReady && left > 0 ? (
                  <span className="tm">
                    · {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
                  </span>
                ) : null}
              </div>
              <div className={`qrbox ${qrReady ? '' : 'busy'}`} style={{ padding: 18, border: '6px solid var(--soft)', borderRadius: 32, position: 'relative' }} data-testid="qris">
                {payment ? <QrCode text={payment.qrString} size={360} level="Q" /> : <div className="qrskel" />}
                <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 20, padding: '4px 12px', fontWeight: 700, fontSize: 30 }}>
                  QRIS
                </div>
              </div>
              <p className="p" style={{ fontSize: 32 }}>
                Scan dengan e-wallet atau m-banking
              </p>
            </>
          ) : pay === 'ok' ? (
            <>
              <div className="pill s" data-testid="pay-ok">
                <Icon n="check" z={34} /> Pembayaran berhasil
              </div>
              <Robot m="cheer" s={300} />
              <div>
                <h2>Lunas</h2>
                <p className="p" style={{ marginTop: 8 }}>
                  Kita mulai sebentar lagi.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="pill f" data-testid="pay-failed">
                <Icon n="x" z={34} /> Pembayaran gagal
              </div>
              <Robot m="think" s={260} />
              <Bubble>{failText}</Bubble>
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
