/**
 * Deterministic session state machine shared by the booth UI and the server.
 *
 * The server is the authority: every state change of a persisted session goes
 * through `transition()` inside the SessionEngine and is stored in the DB.
 * The booth uses the same table to ignore user input that is not valid in the
 * current state (double taps, stale buttons, late timers) so the flow can never
 * be corrupted by repeated clicks.
 */

export const SESSION_STATES = [
  'IDLE',
  'SELECT_PRINT',
  'WAITING_PAYMENT',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'READY',
  'ROBOT_MOVING',
  'POSE_GUIDANCE',
  'COUNTDOWN',
  'CAPTURING',
  'CAPTURE_SUCCESS',
  'ANGLE_COMPLETE',
  'SESSION_COMPLETE',
  'REVIEW',
  'RETAKE',
  'FRAME_SELECTION',
  'PHOTO_SELECTION',
  'EDITING',
  'FINAL_PREVIEW',
  'RENDERING',
  'PRINTING',
  'PRINT_SUCCESS',
  'PRINT_FAILED',
  'GENERATING_GALLERY',
  'QR_READY',
  'FINISHED',
  'RESETTING',
  'ERROR',
  'CANCELLED',
  'EXPIRED',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_EVENTS = [
  'START',
  'PAYMENT_CREATED',
  'QUANTITY_CHANGED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_REJECTED',
  'PAYMENT_EXPIRED',
  'RETRY_PAYMENT',
  'BEGIN',
  'MOVE_ROBOT',
  'ROBOT_ARRIVED',
  'START_COUNTDOWN',
  'CAPTURE',
  'CAPTURE_OK',
  'CAPTURE_FAILED',
  'NEXT_SHOT',
  'ANGLE_DONE',
  'ALL_ANGLES_DONE',
  'SHOW_REVIEW',
  'START_RETAKE',
  'CHOOSE_FRAME',
  'FRAME_CHOSEN',
  'PHOTOS_CHOSEN',
  'EDIT_DONE',
  'BACK',
  'CONFIRM',
  'AUTO_COMPLETE',
  'RENDER_DONE',
  'RENDER_FAILED',
  'PRINT_DONE',
  'PRINT_FAILED',
  'RETRY_PRINT',
  'GENERATE_GALLERY',
  'GALLERY_READY',
  'GALLERY_FAILED',
  'FINISH',
  'RESET',
  'RESET_DONE',
  'CANCEL',
  'TIMEOUT',
  'EXPIRE',
  'FAIL',
] as const;

export type SessionEventType = (typeof SESSION_EVENTS)[number];

type Table = { [S in SessionState]: Partial<Record<SessionEventType, SessionState>> };

export const TRANSITIONS: Table = {
  IDLE: { START: 'SELECT_PRINT' },
  SELECT_PRINT: { PAYMENT_CREATED: 'WAITING_PAYMENT', CANCEL: 'CANCELLED', TIMEOUT: 'CANCELLED', EXPIRE: 'EXPIRED' },
  WAITING_PAYMENT: {
    PAYMENT_CREATED: 'WAITING_PAYMENT',
    QUANTITY_CHANGED: 'SELECT_PRINT',
    PAYMENT_CONFIRMED: 'PAYMENT_SUCCESS',
    PAYMENT_REJECTED: 'PAYMENT_FAILED',
    PAYMENT_EXPIRED: 'PAYMENT_FAILED',
    CANCEL: 'CANCELLED',
    TIMEOUT: 'CANCELLED',
    EXPIRE: 'EXPIRED',
  },
  PAYMENT_FAILED: {
    RETRY_PAYMENT: 'SELECT_PRINT',
    PAYMENT_CREATED: 'WAITING_PAYMENT',
    // A payment that settles late (after the failure was shown) is still honoured.
    PAYMENT_CONFIRMED: 'PAYMENT_SUCCESS',
    CANCEL: 'CANCELLED',
    TIMEOUT: 'CANCELLED',
    EXPIRE: 'EXPIRED',
  },
  PAYMENT_SUCCESS: { BEGIN: 'READY' },
  READY: { MOVE_ROBOT: 'ROBOT_MOVING' },
  ROBOT_MOVING: { ROBOT_ARRIVED: 'POSE_GUIDANCE' },
  POSE_GUIDANCE: { START_COUNTDOWN: 'COUNTDOWN' },
  COUNTDOWN: { CAPTURE: 'CAPTURING' },
  CAPTURING: { CAPTURE_OK: 'CAPTURE_SUCCESS', CAPTURE_FAILED: 'POSE_GUIDANCE' },
  CAPTURE_SUCCESS: { NEXT_SHOT: 'POSE_GUIDANCE', ANGLE_DONE: 'ANGLE_COMPLETE' },
  ANGLE_COMPLETE: { MOVE_ROBOT: 'ROBOT_MOVING', ALL_ANGLES_DONE: 'SESSION_COMPLETE' },
  SESSION_COMPLETE: { SHOW_REVIEW: 'REVIEW' },
  REVIEW: { START_RETAKE: 'RETAKE', CHOOSE_FRAME: 'FRAME_SELECTION', AUTO_COMPLETE: 'RENDERING' },
  RETAKE: { MOVE_ROBOT: 'ROBOT_MOVING' },
  FRAME_SELECTION: { FRAME_CHOSEN: 'PHOTO_SELECTION', BACK: 'REVIEW', AUTO_COMPLETE: 'RENDERING' },
  PHOTO_SELECTION: { PHOTOS_CHOSEN: 'EDITING', BACK: 'FRAME_SELECTION', AUTO_COMPLETE: 'RENDERING' },
  EDITING: { EDIT_DONE: 'FINAL_PREVIEW', BACK: 'PHOTO_SELECTION', AUTO_COMPLETE: 'RENDERING' },
  FINAL_PREVIEW: { CONFIRM: 'RENDERING', BACK: 'EDITING', AUTO_COMPLETE: 'RENDERING' },
  RENDERING: { RENDER_DONE: 'PRINTING', RENDER_FAILED: 'ERROR' },
  PRINTING: { PRINT_DONE: 'PRINT_SUCCESS', PRINT_FAILED: 'PRINT_FAILED' },
  PRINT_SUCCESS: { GENERATE_GALLERY: 'GENERATING_GALLERY' },
  PRINT_FAILED: { GENERATE_GALLERY: 'GENERATING_GALLERY', RETRY_PRINT: 'PRINTING' },
  GENERATING_GALLERY: { GALLERY_READY: 'QR_READY', GALLERY_FAILED: 'ERROR' },
  QR_READY: { FINISH: 'FINISHED', TIMEOUT: 'FINISHED' },
  FINISHED: { RESET: 'RESETTING' },
  RESETTING: { RESET_DONE: 'IDLE' },
  ERROR: { RESET: 'RESETTING' },
  CANCELLED: { RESET: 'RESETTING' },
  EXPIRED: { RESET: 'RESETTING' },
};

/** States from which FAIL is not meaningful. */
const TERMINAL: ReadonlySet<SessionState> = new Set(['IDLE', 'FINISHED', 'RESETTING', 'CANCELLED', 'EXPIRED']);

export const PAID_STATES: ReadonlySet<SessionState> = new Set([
  'PAYMENT_SUCCESS', 'READY', 'ROBOT_MOVING', 'POSE_GUIDANCE', 'COUNTDOWN', 'CAPTURING', 'CAPTURE_SUCCESS',
  'ANGLE_COMPLETE', 'SESSION_COMPLETE', 'REVIEW', 'RETAKE', 'FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING',
  'FINAL_PREVIEW', 'RENDERING', 'PRINTING', 'PRINT_SUCCESS', 'PRINT_FAILED', 'GENERATING_GALLERY', 'QR_READY',
]);

export const UNPAID_STATES: ReadonlySet<SessionState> = new Set(['SELECT_PRINT', 'WAITING_PAYMENT', 'PAYMENT_FAILED']);

export const CAPTURE_STATES: ReadonlySet<SessionState> = new Set([
  'READY', 'ROBOT_MOVING', 'POSE_GUIDANCE', 'COUNTDOWN', 'CAPTURING', 'CAPTURE_SUCCESS', 'ANGLE_COMPLETE', 'RETAKE',
]);

export const SELECTION_STATES: ReadonlySet<SessionState> = new Set([
  'SESSION_COMPLETE', 'REVIEW', 'FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING', 'FINAL_PREVIEW',
]);

export const OUTPUT_STATES: ReadonlySet<SessionState> = new Set([
  'RENDERING', 'PRINTING', 'PRINT_SUCCESS', 'PRINT_FAILED', 'GENERATING_GALLERY',
]);

export const COMPLETED_STATES: ReadonlySet<SessionState> = new Set(['QR_READY', 'FINISHED']);

/** Sessions the booth must recover after a restart. */
export const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(
  SESSION_STATES.filter((s) => !TERMINAL.has(s) && s !== 'ERROR'),
);

export function isTerminal(state: SessionState): boolean {
  return TERMINAL.has(state);
}

export function isPaid(state: SessionState): boolean {
  return PAID_STATES.has(state) || state === 'FINISHED';
}

export function nextState(state: SessionState, event: SessionEventType): SessionState | null {
  const direct = TRANSITIONS[state]?.[event];
  if (direct) return direct;
  if (event === 'FAIL' && !TERMINAL.has(state) && state !== 'ERROR') return 'ERROR';
  return null;
}

export function canTransition(state: SessionState, event: SessionEventType): boolean {
  return nextState(state, event) !== null;
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION';
  constructor(
    readonly from: SessionState,
    readonly event: SessionEventType,
  ) {
    super(`Event ${event} is not allowed in state ${from}`);
  }
}

export function transition(state: SessionState, event: SessionEventType): SessionState {
  const to = nextState(state, event);
  if (!to) throw new InvalidTransitionError(state, event);
  return to;
}

/** The prototype screen each state is rendered on. */
export type BoothScreen =
  | 'welcome'
  | 'pay'
  | 'ready'
  | 'session'
  | 'review'
  | 'tpl'
  | 'pick'
  | 'edit'
  | 'final'
  | 'print'
  | 'qr'
  | 'thanks'
  | 'error';

export function screenForState(state: SessionState): BoothScreen {
  switch (state) {
    case 'IDLE':
    case 'RESETTING':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'welcome';
    case 'SELECT_PRINT':
    case 'WAITING_PAYMENT':
    case 'PAYMENT_SUCCESS':
    case 'PAYMENT_FAILED':
      return 'pay';
    case 'READY':
      return 'ready';
    case 'ROBOT_MOVING':
    case 'POSE_GUIDANCE':
    case 'COUNTDOWN':
    case 'CAPTURING':
    case 'CAPTURE_SUCCESS':
    case 'ANGLE_COMPLETE':
    case 'RETAKE':
      return 'session';
    case 'SESSION_COMPLETE':
    case 'REVIEW':
      return 'review';
    case 'FRAME_SELECTION':
      return 'tpl';
    case 'PHOTO_SELECTION':
      return 'pick';
    case 'EDITING':
      return 'edit';
    case 'FINAL_PREVIEW':
      return 'final';
    case 'RENDERING':
    case 'PRINTING':
    case 'PRINT_SUCCESS':
    case 'PRINT_FAILED':
    case 'GENERATING_GALLERY':
      return 'print';
    case 'QR_READY':
      return 'qr';
    case 'FINISHED':
      return 'thanks';
    case 'ERROR':
      return 'error';
  }
}

/** Ordered prototype flow. */
export const FLOW: BoothScreen[] = ['welcome', 'pay', 'ready', 'session', 'review', 'tpl', 'pick', 'edit', 'final', 'print', 'qr', 'thanks'];
