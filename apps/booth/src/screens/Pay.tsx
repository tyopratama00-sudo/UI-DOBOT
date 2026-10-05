import { useEffect, useRef, useState } from 'react';
import { priceFor, rp } from '@photobooth/shared';
import { useBooth } from '../store';
import { Bubble, Icon, QrCode, Robot } from '../components/basics';
import { puffs } from '../robot/floating';
import { backFromPay, dev, retryPayment, setQty } from '../flow';
import { set as storeSet } from '../store';

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** prototype V.pay — quantity, price, voucher, testing BAYAR button, flying robot */
export function Pay() {
  const session = useBooth((s) => s.session)!;
  const qty = useBooth((s) => s.qty);
  const pricing = useBooth((s) => s.config!.pricing);
  const voucherDiscount = useBooth((s) => s.voucherDiscount);
  const payBusy = useBooth((s) => s.payBusy);
  const payError = useBooth((s) => s.payError);
  const busy = useBooth((s) => s.busy);
  const now = useNow();
  const pr = useRef<HTMLDivElement>(null);
  const [appear, setAppear] = useState(false);

  // voucher state
  const [voucher, setVoucher] = useState('');
  const [voucherOk, setVoucherOk] = useState(false);

  // paid animation state
  const [paidAnim, setPaidAnim] = useState(false);

  const VALID_VOUCHER = 'DISKON10'; // testing: use DISKON10 for Rp 10.000 discount

  const st = session.status;
  const pay: 'wait' | 'ok' | 'fail' = st === 'PAYMENT_SUCCESS' ? 'ok' : st === 'PAYMENT_FAILED' || (payError && !payBusy) ? 'fail' : 'wait';
  const payment = session.payment && session.payment.status === 'PENDING' ? session.payment : null;
  const qrReady = !!payment && payment.quantity === qty && !payBusy;
  const left = payment ? Math.max(0, Math.floor((new Date(payment.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = session.payment?.status === 'EXPIRED';

  // Robot appears AFTER QR is ready (not on page mount)
  useEffect(() => {
    if (!qrReady) return;
    setAppear(true);
    puffs(pr.current, 170, 180, 6);
    const a = setTimeout(() => puffs(pr.current, 170, 180, 4), 300);
    const b = setTimeout(() => setAppear(false), 1300);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [qrReady]);

  // Flying robot animation after payment success
  useEffect(() => {
    if (pay !== 'ok') { setPaidAnim(false); return; }
    setAppear(true);
    puffs(pr.current, 170, 180, 8);
    const t1 = setTimeout(() => setPaidAnim(true), 1300);
    const t2 = setTimeout(() => {
      // import robot dynamically to avoid circular deps
      import('../robot/floating').then(({ robot }) => {
        robot.rbNav('Yeay! Foto soon!', 'cheer', () => {
          // state machine handles navigasi: PAYMENT_SUCCESS → READY → runSession()
        });
      });
    }, 2800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [pay]);

  function applyVoucher() {
    if (voucher.trim().toUpperCase() === VALID_VOUCHER) {
      setVoucherOk(true);
      storeSet({ voucherDiscount: 10000 });
    } else {
      setVoucherOk(false);
      storeSet({ voucherDiscount: 0 });
      import('../robot/floating').then(({ robot }) => {
        robot.say('Voucher tidak valid', 1800);
      });
    }
  }

  function handleBayar() {
    void dev.pay('PAID');
  }

  const total = priceFor(qty, pricing);
  const finalTotal = Math.max(0, total - (voucherOk ? voucherDiscount : 0));

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
          {/* Robot: appears when QR ready or payment success */}
          {(pay === 'wait' && qrReady) || pay === 'ok' ? (
            <div id="pr" ref={pr} style={{ position: 'absolute', right: 36, top: 34, width: 170, height: 180 }}>
              <div className={appear ? 'appear' : ''}>
                <Robot m={pay === 'ok' && paidAnim ? 'cheer' : 'hi'} s={pay === 'ok' && paidAnim ? 170 : 170} />
              </div>
            </div>
          ) : null}
          <div>
            <h2>Pilih jumlah cetakanmu</h2>
            <p className="p" style={{ marginTop: 10, maxWidth: 640 }}>
              Cetak pertama {rp(pricing.firstPrint)}, tambahan +{rp(pricing.additionalPrint)} per lembar
            </p>
          </div>

          {/* Voucher redeem */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="p" style={{ fontSize: 28 }}>Punya voucher?</div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <input
                value={voucher}
                onChange={e => setVoucher(e.target.value)}
                placeholder="Masukkan kode voucher"
                disabled={voucherOk || pay === 'ok'}
                style={{
                  flex: 1,
                  fontSize: 28,
                  padding: '14px 20px',
                  borderRadius: 20,
                  border: `3px solid ${voucherOk ? 'var(--ok)' : 'var(--soft)'}`,
                  fontFamily: 'inherit',
                  background: voucherOk ? '#f0fff4' : '#fff',
                  color: voucherOk ? 'var(--ok)' : 'var(--ink)',
                }}
              />
              <button
                className="btn sm"
                onClick={applyVoucher}
                disabled={!voucher.trim() || voucherOk || pay === 'ok'}
                style={voucherOk ? { background: 'var(--ok)', color: '#fff' } : {}}
              >
                {voucherOk ? '✓' : 'Gunakan'}
              </button>
            </div>
            {voucherOk && (
              <div className="p" style={{ fontSize: 28, color: 'var(--ok)', fontWeight: 600 }}>
                Voucher applied! -{rp(voucherDiscount)}
              </div>
            )}
          </div>

          {/* Quantity selector */}
          <div className="qty" style={{ justifyContent: 'center' }}>
            <button className="btn rnd" onClick={() => setQty(-1)} disabled={qty <= 1 || pay === 'ok'} data-testid="qty-minus">
              −
            </button>
            <b data-testid="qty">{qty}</b>
            <button className="btn rnd" onClick={() => setQty(1)} disabled={qty >= pricing.maxQuantity || pay === 'ok'} data-testid="qty-plus">
              +
            </button>
          </div>

          {/* Total price */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <div className="p">Total</div>
              <div style={{ fontSize: 110, fontWeight: 700, lineHeight: 1, color: 'var(--bl)' }} data-testid="total">
                {voucherOk ? (
                  <span style={{ textDecoration: 'line-through', opacity: 0.5, fontSize: 70 }}>{rp(total)}</span>
                ) : null}
                <span style={voucherOk ? { marginLeft: 12, fontSize: 110 } : {}}>{rp(finalTotal)}</span>
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

              {/* Testing: BAYAR SEKARANG button instead of QR */}
              {qrReady ? (
                <button
                  className="btn pr"
                  style={{ width: '100%', height: 160, fontSize: 48 }}
                  onClick={handleBayar}
                  data-testid="pay-bayar"
                >
                  <Icon n="check" z={48} /> BAYAR SEKARANG
                </button>
              ) : (
                <div className={`qrbox ${qrReady ? '' : 'busy'}`} style={{ padding: 18, border: '6px solid var(--soft)', borderRadius: 32, position: 'relative' }} data-testid="qris">
                  {payment ? <QrCode text={payment.qrString} size={360} level="Q" /> : <div className="qrskel" />}
                  <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 20, padding: '4px 12px', fontWeight: 700, fontSize: 30 }}>
                    QRIS
                  </div>
                </div>
              )}

              <p className="p" style={{ fontSize: 32 }}>
                {qrReady ? 'Tekan tombol untuk bayar (testing)' : 'Sedang membuat QR...'}
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
