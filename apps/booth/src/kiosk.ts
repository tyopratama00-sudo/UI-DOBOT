/**
 * Kiosk hardening for an unattended touchscreen: no context menu, no text
 * selection, no drag, no pinch/ctrl zoom, no accidental back navigation.
 * The device key (optional BOOTH_DEVICE_KEY) is read once from ?device= and
 * kept in localStorage — it is never compiled into the bundle.
 */

const KEY = 'pb.deviceKey';

export function captureDeviceKey() {
  try {
    const url = new URL(location.href);
    const k = url.searchParams.get('device');
    if (k) {
      localStorage.setItem(KEY, k);
      url.searchParams.delete('device');
      history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch {
    /* storage unavailable */
  }
}

export function deviceKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function devMode(): boolean {
  return new URLSearchParams(location.search).has('dev');
}

export function installKioskGuards() {
  const prevent = (e: Event) => e.preventDefault();
  const allowDev = devMode();
  if (!allowDev) document.addEventListener('contextmenu', prevent);
  document.addEventListener('selectstart', prevent);
  document.addEventListener('dragstart', prevent);
  // Safari/iPad gesture zoom
  document.addEventListener('gesturestart', prevent as EventListener, { passive: false } as AddEventListenerOptions);
  // ctrl/cmd + wheel zoom
  window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  // multi-touch pinch on the page itself (the editor handles its own pointers)
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && !(e.target as HTMLElement)?.closest?.('.slot')) e.preventDefault();
    },
    { passive: false },
  );
  // keyboard zoom / reload / navigation shortcuts
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', 'r', 'p', 's', 'o', 'u', 'f'].includes(k)) e.preventDefault();
    if (!allowDev && (k === 'f5' || k === 'f12' || (e.altKey && (k === 'arrowleft' || k === 'arrowright')))) e.preventDefault();
    if (k === 'backspace' && !(e.target as HTMLElement)?.closest?.('input,textarea')) e.preventDefault();
  });
  // Swallow browser "back" (touchpad swipe / mouse button)
  history.pushState(null, '', location.href);
  window.addEventListener('popstate', () => history.pushState(null, '', location.href));
  // Keep the screen awake where supported
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } };
  const wake = () => void nav.wakeLock?.request('screen').catch(() => undefined);
  wake();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
}

export async function requestFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* not allowed without gesture / already kiosk */
  }
}
