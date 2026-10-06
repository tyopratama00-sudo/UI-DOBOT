import {
  applyEditOp,
  autoPick as autoPickIds,
  CAPTURE_STATES,
  chooseForAngle,
  clampQuantity,
  defaultEdit,
  DEFAULT_TEMPLATE_ID,
  FILTERS,
  isTerminal,
  nextMissingStep,
  p2,
  togglePick as togglePickIds,
  type EditOp,
  type EditParams,
  type SessionCommand,
  type SessionSnapshot,
  type SessionState,
} from '@photobooth/shared';
import { api, ApiError, NetworkError, newRequestId, onConnectivity } from './api/client';
import { getCamera, cameraInstance } from './camera/service';
import { robot } from './robot/floating';
import { currentScreen, currentTemplate, flatPhotos, get, plan, scaleMs, set, type BoothState } from './store';

/* ------------------------------------------------------------------ abort token (prototype `tok`) */

let tok = 0;
class Aborted extends Error {}
const wait = (ms: number, t: number) =>
  new Promise<void>((res, rej) => setTimeout(() => (t === tok ? res() : rej(new Aborted())), scaleMs(ms)));
const isAbort = (e: unknown) => e instanceof Aborted;

const SAVE_KEY = 'pb.session';
function saveSession() {
  try {
    if (api.sessionId && api.token) localStorage.setItem(SAVE_KEY, JSON.stringify({ id: api.sessionId, token: api.token }));
  } catch {
    /* ignore */
  }
}
function loadSaved(): { id: string; token: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  } catch {
    return null;
  }
}
function clearSaved() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

let unsubscribe: (() => void) | null = null;
let captureRunning = false;
let beginScheduled = false;

/* ------------------------------------------------------------------ boot & recovery */

export async function boot() {
  for (let attempt = 0; ; attempt++) {
    try {
      const config = await api.config();
      set({ config, readyCd: config.session.readySeconds, bootError: null });
      break;
    } catch (e) {
      set({ bootError: (e as Error).message });
      await new Promise((r) => setTimeout(r, Math.min(10000, 1500 * (attempt + 1))));
    }
  }
  const config = get().config!;
  const cam = getCamera(config.camera);
  cam.onStatus((st) => set({ cameraState: st.state, cameraError: st.lastError ?? null }));
  if (config.camera.mode === 'browser') void cam.start().catch(() => undefined);

  onConnectivity((online) => {
    set({ online });
    if (online) void resync();
  });

  await refreshHealth();
  await recover();
  set({ booted: true });

  setInterval(() => {
    const s = get();
    if (!s.session) void refreshHealth();
    const c = cameraInstance();
    if (c && c.mode === 'browser' && s.cameraState === 'error' && !s.session) void c.start().catch(() => undefined);
  }, 15000);
  setInterval(() => void heartbeat(), 10000);
  void heartbeat();
}

export async function refreshHealth() {
  try {
    const h = await api.health();
    set({ health: { acceptingSessions: h.acceptingSessions, checkedAt: h.checkedAt, components: h.components } });
  } catch {
    /* keep last known */
  }
}

async function heartbeat() {
  const s = get();
  const cam = cameraInstance();
  try {
    const r = await api.heartbeat({
      camera: cam?.mode === 'browser' ? { state: s.cameraState, model: cam.status().model, error: s.cameraError ?? undefined } : undefined,
      screen: currentScreen(s),
      sessionId: s.session?.id ?? null,
    });
    cam?.setFault(r.cameraFault);
  } catch {
    /* offline */
  }
}

async function recover() {
  const saved = loadSaved();
  let snap: SessionSnapshot | null = null;
  if (saved) {
    api.sessionId = saved.id;
    api.token = saved.token;
    try {
      snap = await api.getSession();
    } catch {
      api.clear();
      clearSaved();
    }
  }
  if (!snap || isTerminal(snap.status)) {
    try {
      const r = await api.active();
      if (r.session && r.token) {
        api.sessionId = r.session.id;
        api.token = r.token;
        snap = r.session;
      }
    } catch {
      /* no recovery possible */
    }
  }
  if (snap && !isTerminal(snap.status) && snap.status !== 'FINISHED') {
    saveSession();
    subscribe();
    applySnapshot(snap, true);
  } else {
    api.clear();
    clearSaved();
  }
}

function subscribe() {
  unsubscribe?.();
  unsubscribe = api.subscribe((s) => applySnapshot(s));
}

export async function resync() {
  if (!api.sessionId) return;
  try {
    applySnapshot(await api.getSession());
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) resetToWelcome();
  }
}

/* ------------------------------------------------------------------ snapshots */

export function applySnapshot(next: SessionSnapshot, recovering = false) {
  const s = get();
  const prev = s.session;
  if (!api.sessionId || next.id !== api.sessionId) return;
  if (prev && prev.id === next.id && next.version < prev.version) return; // stale
  const patch: Partial<BoothState> = { session: next };
  if (!prev || prev.status !== next.status || recovering) onEnterState(prev?.status ?? null, next, patch, recovering);
  set(patch);
}

function onEnterState(prevStatus: SessionState | null, next: SessionSnapshot, patch: Partial<BoothState>, recovering: boolean) {
  const s = get();
  switch (next.status) {
    case 'SELECT_PRINT':
    case 'WAITING_PAYMENT':
      if (recovering) patch.qty = next.quantity;
      break;
    case 'PAYMENT_SUCCESS':
      if (!beginScheduled) {
        beginScheduled = true;
        const t = tok;
        setTimeout(() => {
          beginScheduled = false;
          if (t === tok) beginAfterPayment();
        }, scaleMs(2800));
      }
      break;
    case 'READY':
      void runSession(null);
      break;
    case 'RETAKE':
      void runSession(next.capture.retakeAngle ?? next.retakenAngles[next.retakenAngles.length - 1] ?? 0);
      break;
    case 'FRAME_SELECTION':
      if (prevStatus !== 'PHOTO_SELECTION' || recovering) patch.tplId = next.templateId ?? defaultTemplateFor(next);
      break;
    case 'PHOTO_SELECTION':
      if (prevStatus !== 'EDITING' || recovering) patch.picks = [...next.slots].sort((a, b) => a.slotIndex - b.slotIndex).map((x) => x.photoId);
      if (next.templateId) patch.tplId = next.templateId;
      break;
    case 'EDITING':
      if (prevStatus !== 'EDITING') {
        patch.edits = Object.fromEntries(next.slots.map((x) => [x.slotIndex, x.edit]));
        patch.picks = [...next.slots].sort((a, b) => a.slotIndex - b.slotIndex).map((x) => x.photoId);
        if (prevStatus !== 'FINAL_PREVIEW') patch.slot = 0;
        if (next.templateId) patch.tplId = next.templateId;
      }
      break;
    case 'FINAL_PREVIEW':
    case 'REVIEW':
      if (next.templateId) patch.tplId = next.templateId;
      if (next.status === 'FINAL_PREVIEW' && (recovering || prevStatus !== 'EDITING'))
        patch.edits = Object.fromEntries(next.slots.map((x) => [x.slotIndex, x.edit]));
      break;
    case 'PRINT_FAILED':
      patch.holdPrintUntil = Date.now() + 6500;
      break;
    case 'CANCELLED':
    case 'EXPIRED':
      setTimeout(resetToWelcome, 0);
      break;
    default:
      break;
  }
  // A restart in the middle of the capture phase: re-synchronise with the server.
  if (recovering && CAPTURE_STATES.has(next.status) && !['READY', 'RETAKE'].includes(next.status)) void sendResilient({ type: 'resume' });
  if (recovering && next.status === 'SESSION_COMPLETE') void sendResilient({ type: 'resume' });
  void s;
}

/** Prototype default (Strip Klasik) unless the session has too few photos for it. */
function defaultTemplateFor(sess: SessionSnapshot): string {
  const list = get().config?.templates ?? [];
  const n = sess.photos.filter((p) => p.selected).length;
  const def = list.find((t) => t.id === DEFAULT_TEMPLATE_ID);
  if (def && def.photoCount <= n) return def.id;
  const fit = list.filter((t) => t.photoCount <= n).sort((a, b) => b.photoCount - a.photoCount);
  return fit[0]?.id ?? DEFAULT_TEMPLATE_ID;
}

/* ------------------------------------------------------------------ commands */

export async function send(cmd: SessionCommand, opts: { timeoutMs?: number; requestId?: string; retries?: number } = {}): Promise<SessionSnapshot | null> {
  try {
    const snap = await api.command(cmd, opts);
    applySnapshot(snap);
    return snap;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'INVALID_TRANSITION') {
      await resync();
      return null;
    }
    throw e;
  }
}

/** Keeps retrying through network outages (same request id → idempotent). */
async function sendResilient(cmd: SessionCommand, timeoutMs?: number): Promise<SessionSnapshot | null> {
  const requestId = newRequestId();
  const t = tok;
  for (let i = 0; ; i++) {
    try {
      return await send(cmd, { requestId, timeoutMs });
    } catch (e) {
      if (!(e instanceof NetworkError) || t !== tok) throw e;
      await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + i * 500)));
    }
  }
}

/** Button actions: guard against double taps, surface friendly errors. */
async function guard(name: string, fn: () => Promise<unknown>) {
  if (get().busy) return;
  set({ busy: name });
  try {
    await fn();
  } catch (e) {
    if (isAbort(e)) return;
    const msg = (e as ApiError).userMessage ?? (e instanceof NetworkError ? e.userMessage : 'Terjadi kendala. Coba lagi, ya.');
    robot.say(msg, 2600);
    set({ notice: msg });
    setTimeout(() => get().notice === msg && set({ notice: null }), 4000);
  } finally {
    set({ busy: null });
  }
}

/* ------------------------------------------------------------------ welcome & payment */

let payTimer: ReturnType<typeof setTimeout> | undefined;

export async function startSession() {
  const s = get();
  if (s.entering || s.session) return;
  set({ entering: true, qty: 1, payError: null, payBusy: true });
  const t = tok;
  const anim = new Promise((r) => setTimeout(r, 1900));
  try {
    const r = await api.createSession();
    if (t !== tok) return;
    saveSession();
    subscribe();
    applySnapshot(r.session);
    void requestPayment(1);
  } catch (e) {
    await anim;
    set({ entering: false, payBusy: false, session: null });
    api.clear();
    if (e instanceof ApiError && e.code === 'MAINTENANCE') await refreshHealth();
    else robot.say((e as ApiError).userMessage ?? 'Sistem sedang menyambung ulang…', 2500);
    return;
  }
  await anim;
  if (t === tok) set({ entering: false });
}

async function requestPayment(q: number) {
  set({ payBusy: true, payError: null });
  try {
    const st = get().session?.status;
    if (st === 'PAYMENT_FAILED') await send({ type: 'retry_payment' });
    const snap = await api.payment(q);
    applySnapshot(snap);
    if (get().qty === q) set({ payBusy: false });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'INVALID_TRANSITION') {
      await resync();
      set({ payBusy: false });
      return;
    }
    set({ payBusy: false, payError: (e as ApiError).userMessage ?? 'Layanan pembayaran sedang sibuk. Coba lagi sebentar lagi.' });
  }
}

/** prototype sq(): change quantity; a fresh dynamic QR is requested (debounced). */
export function setQty(delta: number) {
  const s = get();
  const max = s.config?.pricing.maxQuantity ?? 10;
  const q = clampQuantity(s.qty + delta, { ...s.config!.pricing, maxQuantity: max });
  if (q === s.qty) return;
  set({ qty: q, payError: null, payBusy: true });
  clearTimeout(payTimer);
  payTimer = setTimeout(() => void requestPayment(get().qty), 650);
}

export function retryPayment() {
  void guard('retry-pay', () => requestPayment(get().qty));
}

export async function simulateMockPayment() {
  const s = get().session;
  if (!get().config?.mockPayment || !s?.payment || s.payment.status !== 'PENDING' || get().payBusy) return;
  const orderId = s.payment.qrString.split('/mock-pay/')[1];
  if (!orderId) {
    set({ payError: 'Kode pembayaran demo tidak valid.' });
    return;
  }
  set({ payBusy: true, payError: null });
  try {
    await api.mockPay(decodeURIComponent(orderId));
  } catch (e) {
    set({ payError: (e as ApiError).userMessage ?? 'Pembayaran demo gagal. Coba lagi.' });
  } finally {
    set({ payBusy: false });
  }
}

export function beginAfterPayment() {
  robot.flyRight(() => void sendResilient({ type: 'begin' }));
}

export function backFromPay() {
  void guard('cancel', async () => {
    clearTimeout(payTimer);
    try {
      await send({ type: 'cancel' }, { retries: 1 });
    } catch {
      /* the server reaper expires it anyway */
    }
    if (get().session && ['CANCELLED', 'EXPIRED'].includes(get().session!.status)) resetToWelcome();
    else if (!get().session || get().session!.status !== 'PAYMENT_SUCCESS') resetToWelcome();
  });
}

/* ------------------------------------------------------------------ capture (prototype ready() + run()) */

function setCapture(p: Partial<BoothState['capture']>) {
  set({ capture: { ...get().capture, ...p } });
}

async function runSession(retakeAngle: number | null) {
  if (captureRunning) return;
  captureRunning = true;
  const t = tok;
  const cfg = get().config!;
  try {
    if (retakeAngle === null) {
      // READY: "Mulai dalam N detik"
      const total = get().session?.plan.readySeconds ?? cfg.session.readySeconds;
      for (let cd = total; cd > 0; cd--) {
        set({ readyCd: cd });
        await wait(900, t);
      }
    }
    await runCapture(t, retakeAngle);
  } catch (e) {
    if (!isAbort(e)) {
      set({ notice: (e as ApiError).userMessage ?? 'Terjadi kendala.' });
      await resync();
    }
  } finally {
    captureRunning = false;
  }
}

async function runCapture(t: number, retakeAngle: number | null) {
  const sess = get().session!;
  const p = sess.plan;
  const cam = cameraInstance()!;
  let angles: number[];
  let firstShot = 0;
  if (retakeAngle === null) {
    const next = nextMissingStep(sess.photos, p.angles, p.shotsPerAngle);
    if (!next) {
      await sendResilient({ type: 'move', angle: p.angles - 1 }, 60000).catch(() => undefined);
      return;
    }
    angles = [...Array(p.angles).keys()].filter((a) => a >= next.angle);
    firstShot = next.shot;
  } else {
    angles = [retakeAngle];
    firstShot = sess.photos.filter((x) => x.angle === retakeAngle && x.retaken).length;
  }

  for (const [ai, a] of angles.entries()) {
    setCapture({ angle: a, shot: 0, phase: 'move', message: '', cd: null, shotUrl: null });
    await Promise.all([sendResilient({ type: 'move', angle: a }, 90000), wait(1300, t)]);
    const start = ai === 0 ? firstShot : 0;
    for (let k = start; k < p.shotsPerAngle; k++) {
      let attempts = 0;
      for (;;) {
        setCapture({ shot: k + 1, phase: 'prep', message: '', cd: null, shotUrl: null });
        await wait(2600, t);
        await sendResilient({ type: 'countdown', angle: a, shot: k });
        setCapture({ phase: 'cd' });
        for (let n = p.countdownSeconds; n >= 1; n--) {
          cd(n);
          await wait(650, t);
        }
        cd('cam');
        flash();
        const requestId = newRequestId();
        const shooting = cam.shoot(a, k, requestId);
        shooting.catch(() => undefined);
        try {
          await wait(500, t);
          setCapture({ phase: 'nice', message: k + 1 < p.shotsPerAngle ? 'Bagus banget!' : 'Mantap! Sudut ini selesai.' });
          const [snap] = await Promise.all([shooting, wait(800, t)]);
          applySnapshot(snap);
          // Show the photo just taken before going back to the live view.
          const taken = snap.photos.filter((x) => x.angle === a && x.shot === k).at(-1);
          if (taken) {
            setCapture({ shotUrl: taken.previewUrl });
            await wait(1500, t);
          }
          break;
        } catch (e) {
          if (isAbort(e)) throw e;
          attempts++;
          const status = get().session?.status;
          // Browser capture failures never reached the server: report them.
          if (status === 'COUNTDOWN' || status === 'CAPTURING') {
            await sendResilient({ type: 'capture_failed', angle: a, shot: k, reason: (e as Error).message.slice(0, 250) }).catch(() => undefined);
          } else await resync();
          if (get().session?.status === 'ERROR') return;
          setCapture({ phase: 'retry', message: 'Foto gagal diambil. Kita coba lagi, ya.', cd: null, shotUrl: null });
          robot.react('think', 'wob', 'Coba lagi, ya!', null, 1.6);
          await wait(1800, t);
          if (attempts > 6) throw e;
        }
      }
      if (k + 1 < p.shotsPerAngle) await sendResilient({ type: 'next_shot' });
      else await sendResilient({ type: 'angle_done' });
    }
  }
}

function cd(v: number | 'cam') {
  const c = get().capture as BoothState['capture'] & { cd?: number | 'cam'; cdKey?: number };
  set({ capture: { ...c, cd: v, cdKey: (c.cdKey ?? 0) + 1 } as BoothState['capture'] });
}
function flash() {
  const c = get().capture as BoothState['capture'] & { flashKey?: number };
  set({ capture: { ...c, flashKey: (c.flashKey ?? 0) + 1 } as BoothState['capture'] });
}

/* ------------------------------------------------------------------ review */

export function tapReviewPhoto(angle: number, id: string) {
  const s = get();
  const sess = s.session!;
  const ps = sess.photos.filter((x) => x.angle === angle);
  if (ps.length <= sess.plan.shotsPerAngle) {
    set({ big: id });
    return;
  }
  const sel = ps.filter((x) => x.selected).sort((a, b) => a.shot - b.shot).map((x) => x.id);
  if (sel.includes(id)) return;
  const next = chooseForAngle(sel, id, sess.plan.shotsPerAngle);
  // optimistic: reflect immediately, the server confirms
  set({ session: { ...sess, photos: sess.photos.map((x) => (x.angle === angle ? { ...x, selected: next.includes(x.id), superseded: !next.includes(x.id) } : x)) } });
  void send({ type: 'select_angle', angle, photoIds: next }).catch(() => resync());
  robot.react('thumbs', 'wob', 'Pilihan bagus!', null, 1.2);
}

export function retake(angle: number) {
  robot.rbNav(`Ulang sudut ${p2(angle + 1)}`, 'cam', () => void guard('retake', () => send({ type: 'retake', angle })));
}

export function skipSession() {
  captureRunning = false;
  tok++;
  robot.rbNav('Selesai!', 'cheer', () => {
    if (get().busy) return;
    void send({ type: 'skip_angles' });
  });
}

export function toFrames() {
  robot.rbNav('Lanjut pilih frame!', 'point', () => void guard('frames', () => send({ type: 'choose_frame' })));
}

export function back() {
  void guard('back', async () => {
    if (get().session?.status === 'EDITING') await flushEdits();
    await send({ type: 'back' });
  });
}

/* ------------------------------------------------------------------ frame */

export function chooseTemplate(id: string) {
  const s = get();
  const t = s.config?.templates.find((x) => x.id === id);
  if (!t) return;
  set({ tplId: id, picks: [], edits: {} });
  void send({ type: 'set_template', templateId: id }).catch(() => undefined);
  const r = t.reaction;
  if (r) robot.react(r.pose, r.anim, r.text, r.fx, 1.7);
}

export function confirmTemplate() {
  robot.rbNav('Pilih fotonya, yuk!', 'point', () => void guard('frame', () => send({ type: 'frame', templateId: currentTemplate(get()).id })));
}

/* ------------------------------------------------------------------ pick (prototype fpk / autoFp) */

export function togglePick(id: string) {
  const s = get();
  const n = currentTemplate(s).photoCount;
  const { picks, added } = togglePickIds(s.picks, id, n);
  set({ picks });
  const angle = (s.session?.photos.find((x) => x.id === id)?.angle ?? 0) + 1;
  if (!added) robot.react('think', null, 'Batal? Oke', '', 1.2);
  else if (picks.length == n) robot.react('cheer', 'hop', 'Lengkap! Lanjut, yuk', 'star', 1.8);
  else robot.react('thumbs', 'wob', 'Sudut ' + angle + ', bagus!', '', 1.2);
}

export function autoPick() {
  const s = get();
  set({ picks: autoPickIds(flatPhotos(s).map((x) => x.id), currentTemplate(s).photoCount) });
  robot.react('free', 'dance', 'Dipilihkan!', 'star', 1.6);
}

export function clearPicks() {
  set({ picks: [] });
  robot.react('shock', 'shake', 'Kosong lagi!', null, 1.2);
}

export function confirmPicks() {
  const s = get();
  if (s.picks.length !== currentTemplate(s).photoCount) return;
  robot.rbNav('Saatnya edit!', 'point', () => void guard('photos', () => send({ type: 'photos', photoIds: get().picks })));
}

/* ------------------------------------------------------------------ edit (prototype ed() + gestures) */

let editTimer: ReturnType<typeof setTimeout> | undefined;

export function editOf(slot: number): EditParams {
  return get().edits[slot] ?? defaultEdit();
}

export function selectSlot(i: number) {
  if (get().slot !== i) robot.say('Foto ' + (i + 1) + ' dipilih', 1100);
  set({ slot: i });
}

export function setEdit(slot: number, e: EditParams) {
  set({ edits: { ...get().edits, [slot]: e } });
  clearTimeout(editTimer);
  editTimer = setTimeout(() => void flushEdits(), 1200);
}

async function flushEdits() {
  clearTimeout(editTimer);
  const s = get();
  if (s.session?.status !== 'EDITING') return;
  const slots = Object.entries(s.edits).map(([k, edit]) => ({ slotIndex: Number(k), edit }));
  if (slots.length) await api.command({ type: 'edits', slots }, { retries: 2 }).catch(() => undefined);
}

export function editOp(op: EditOp) {
  const s = get();
  const e = applyEditOp(editOf(s.slot), op);
  setEdit(s.slot, e);
  const rx: Partial<Record<EditOp['op'], [string, string, string]>> = {
    rotate90: ['cool', 'spin', 'Muter!'],
    flip: ['peace', 'wob', 'Dibalik!'],
    brightness: op.op === 'brightness' && op.delta > 0 ? ['cheer', 'hop', 'Terang!'] : ['think', 'wob', 'Redup...'],
    filter: ['heart', 'wob', op.op === 'filter' ? (FILTERS.find((f) => f.id === op.filter)?.reaction ?? 'Natural!') : ''],
    crop: ['thumbs', 'wob', 'Dipotong!'],
    reset: ['shock', 'shake', 'Reset!'],
  };
  const r = rx[op.op];
  if (r) robot.react(r[0], r[1], r[2], op.op === 'filter' ? 'heart' : null, 1.3);
}

export function editDone() {
  robot.rbNav('Hampir selesai!', 'cheer', () =>
    void guard('edit_done', async () => {
      clearTimeout(editTimer);
      const slots = Object.entries(get().edits).map(([k, edit]) => ({ slotIndex: Number(k), edit }));
      await send({ type: 'edit_done', slots });
    }),
  );
}

/* ------------------------------------------------------------------ final / print / qr / thanks */

export function confirmPrint() {
  robot.rbNav('Siap cetak!', 'cheer', () => void guard('confirm', () => send({ type: 'confirm' })));
}

export function finish() {
  void guard('finish', () => send({ type: 'finish' }));
}

/** Timeout handling per screen (unpaid → cancel, paid → auto-complete, done → finish). */
export function onIdleTimeout() {
  const s = get();
  const st = s.session?.status;
  if (!st) return;
  if (st === 'SELECT_PRINT' || st === 'WAITING_PAYMENT' || st === 'PAYMENT_FAILED') return backFromPay();
  if (['REVIEW', 'FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING'].includes(st))
    return void guard('auto', async () => {
      await flushEdits();
      await send({ type: 'auto_complete' });
    });
  if (st === 'FINAL_PREVIEW') return void guard('auto', () => send({ type: 'confirm' }));
  if (st === 'QR_READY') return finish();
  if (st === 'FINISHED' || st === 'ERROR') return resetToWelcome();
}

/** prototype init(); go('welcome') */
export function resetToWelcome() {
  tok++;
  captureRunning = false;
  beginScheduled = false;
  clearTimeout(payTimer);
  clearTimeout(editTimer);
  unsubscribe?.();
  unsubscribe = null;
  api.clear();
  clearSaved();
  set({
    session: null,
    entering: false,
    holdPrintUntil: 0,
    qty: 1,
    payBusy: false,
    payError: null,
    tplId: DEFAULT_TEMPLATE_ID,
    picks: [],
    edits: {},
    slot: 0,
    capture: { angle: 0, shot: 0, phase: '', message: '' },
    big: null,
    busy: null,
    notice: null,
    clientError: null,
    idle: null,
    readyCd: get().config?.session.readySeconds ?? 5,
  });
  void refreshHealth();
}

export function closeLightbox() {
  set({ big: null });
}

/* Dev helpers (only reachable from the ?dev toolbar in non-production builds). */
export const dev = {
  async pay(status: 'PAID' | 'FAILED') {
    const s = get().session;
    if (!s?.payment) return;
    await fetch(`/mock-pay/${encodeURIComponent(s.payment.qrString.split('/mock-pay/')[1] ?? '')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => undefined);
  },
};
