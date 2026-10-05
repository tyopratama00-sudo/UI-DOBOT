import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  activePhotos,
  DEFAULT_TEMPLATE_ID,
  findTemplate,
  screenForState,
  type BoothConfig,
  type BoothScreen,
  type EditParams,
  type PhotoDTO,
  type PhotoTemplate,
  type SessionSnapshot,
} from '@photobooth/shared';

export type CapturePhase = 'move' | 'prep' | 'cd' | 'nice' | 'retry' | '';

export interface HealthState {
  acceptingSessions: boolean;
  checkedAt: string;
  components: Record<string, { status: string; critical: boolean; message: string }>;
}

export interface BoothState {
  booted: boolean;
  bootError: string | null;
  config: BoothConfig | null;
  health: HealthState | null;
  online: boolean;
  cameraState: string;
  cameraError: string | null;

  session: SessionSnapshot | null;
  /** welcome → pay ninja animation in progress */
  entering: boolean;
  /** keep the print screen visible (e.g. to show a print failure) until this time */
  holdPrintUntil: number;

  // local UI state (prototype S.*)
  qty: number;
  payBusy: boolean;
  payError: string | null;
  tplId: string;
  picks: string[];
  edits: Record<number, EditParams>;
  slot: number;
  capture: { angle: number; shot: number; phase: CapturePhase; message: string; cd?: number | 'cam' | null; cdKey?: number; flashKey?: number };
  readyCd: number;
  big: string | null;
  busy: string | null;
  notice: string | null;
  clientError: { code: string; message: string } | null;
  idle: { secondsLeft: number; total: number; kind: 'unpaid' | 'paid' | 'done' } | null;
}

export const useBooth = create<BoothState>(() => ({
  booted: false,
  bootError: null,
  config: null,
  health: null,
  online: true,
  cameraState: 'disconnected',
  cameraError: null,
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
  readyCd: 5,
  big: null,
  busy: null,
  notice: null,
  clientError: null,
  idle: null,
}));

export const set = useBooth.setState;
export const get = useBooth.getState;

/** Which prototype screen to show. */
export function currentScreen(s: BoothState, now = Date.now()): BoothScreen {
  if (s.clientError) return 'error';
  const sess = s.session;
  if (!sess) return 'welcome';
  if (s.entering) return 'welcome';
  if (now < s.holdPrintUntil) return 'print';
  return screenForState(sess.status);
}

export function templates(s: BoothState): PhotoTemplate[] {
  return s.config?.templates ?? [];
}

export function currentTemplate(s: BoothState): PhotoTemplate {
  const list = templates(s);
  return findTemplate(list, s.tplId) ?? findTemplate(list, s.session?.templateId) ?? findTemplate(list, DEFAULT_TEMPLATE_ID) ?? list[0];
}

/** prototype flat(): the session's active photos ordered by angle/shot */
export function flatPhotos(s: BoothState): PhotoDTO[] {
  return activePhotos(s.session?.photos ?? []);
}

export function photoById(s: BoothState, id: string | undefined | null): PhotoDTO | undefined {
  return id ? s.session?.photos.find((p) => p.id === id) : undefined;
}

export function plan(s: BoothState) {
  return s.session?.plan ?? { angles: s.config?.session.angles ?? 10, shotsPerAngle: s.config?.session.shotsPerAngle ?? 2, retakeLimit: s.config?.session.retakeLimit ?? 2, countdownSeconds: s.config?.session.countdownSeconds ?? 3, readySeconds: s.config?.session.readySeconds ?? 5 };
}

export function scaleMs(ms: number): number {
  return ms * (get().config?.timingScale ?? 1);
}

/** Stable (shallow-compared) flat photo list for React components. */
export function useFlatPhotos() {
  return useBooth(useShallow(flatPhotos));
}
