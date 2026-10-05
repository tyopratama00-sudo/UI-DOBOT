import { describe, expect, it } from 'vitest';
import {
  canTransition,
  InvalidTransitionError,
  isPaid,
  nextState,
  screenForState,
  SESSION_EVENTS,
  SESSION_STATES,
  transition,
  TRANSITIONS,
  type SessionEventType,
  type SessionState,
} from '../src/fsm';

describe('session state machine', () => {
  it('defines a transition table entry for every state', () => {
    for (const s of SESSION_STATES) expect(TRANSITIONS[s]).toBeDefined();
  });

  it('only references known states and events', () => {
    for (const [from, map] of Object.entries(TRANSITIONS)) {
      expect(SESSION_STATES).toContain(from);
      for (const [ev, to] of Object.entries(map)) {
        expect(SESSION_EVENTS).toContain(ev);
        expect(SESSION_STATES).toContain(to);
      }
    }
  });

  it('walks the complete happy path of the prototype flow', () => {
    const path: [SessionEventType, SessionState][] = [
      ['START', 'SELECT_PRINT'],
      ['PAYMENT_CREATED', 'WAITING_PAYMENT'],
      ['PAYMENT_CONFIRMED', 'PAYMENT_SUCCESS'],
      ['BEGIN', 'READY'],
      ['MOVE_ROBOT', 'ROBOT_MOVING'],
      ['ROBOT_ARRIVED', 'POSE_GUIDANCE'],
      ['START_COUNTDOWN', 'COUNTDOWN'],
      ['CAPTURE', 'CAPTURING'],
      ['CAPTURE_OK', 'CAPTURE_SUCCESS'],
      ['NEXT_SHOT', 'POSE_GUIDANCE'],
      ['START_COUNTDOWN', 'COUNTDOWN'],
      ['CAPTURE', 'CAPTURING'],
      ['CAPTURE_OK', 'CAPTURE_SUCCESS'],
      ['ANGLE_DONE', 'ANGLE_COMPLETE'],
      ['ALL_ANGLES_DONE', 'SESSION_COMPLETE'],
      ['SHOW_REVIEW', 'REVIEW'],
      ['CHOOSE_FRAME', 'FRAME_SELECTION'],
      ['FRAME_CHOSEN', 'PHOTO_SELECTION'],
      ['PHOTOS_CHOSEN', 'EDITING'],
      ['EDIT_DONE', 'FINAL_PREVIEW'],
      ['CONFIRM', 'RENDERING'],
      ['RENDER_DONE', 'PRINTING'],
      ['PRINT_DONE', 'PRINT_SUCCESS'],
      ['GENERATE_GALLERY', 'GENERATING_GALLERY'],
      ['GALLERY_READY', 'QR_READY'],
      ['FINISH', 'FINISHED'],
      ['RESET', 'RESETTING'],
      ['RESET_DONE', 'IDLE'],
    ];
    let s: SessionState = 'IDLE';
    for (const [ev, expected] of path) {
      s = transition(s, ev);
      expect(s).toBe(expected);
    }
  });

  it('rejects invalid transitions (repeated clicks cannot corrupt the session)', () => {
    expect(() => transition('IDLE', 'CONFIRM')).toThrow(InvalidTransitionError);
    expect(canTransition('WAITING_PAYMENT', 'BEGIN')).toBe(false);
    // double-confirm: second CONFIRM in RENDERING is rejected
    expect(canTransition(transition('FINAL_PREVIEW', 'CONFIRM'), 'CONFIRM')).toBe(false);
    // capture is impossible without payment
    expect(canTransition('SELECT_PRINT', 'MOVE_ROBOT')).toBe(false);
    expect(canTransition('WAITING_PAYMENT', 'CAPTURE')).toBe(false);
  });

  it('supports retake, back navigation, failures and auto-complete', () => {
    expect(transition('REVIEW', 'START_RETAKE')).toBe('RETAKE');
    expect(transition('RETAKE', 'MOVE_ROBOT')).toBe('ROBOT_MOVING');
    expect(transition('CAPTURING', 'CAPTURE_FAILED')).toBe('POSE_GUIDANCE');
    expect(transition('PHOTO_SELECTION', 'BACK')).toBe('FRAME_SELECTION');
    expect(transition('EDITING', 'AUTO_COMPLETE')).toBe('RENDERING');
    expect(transition('PRINTING', 'PRINT_FAILED')).toBe('PRINT_FAILED');
    expect(transition('PRINT_FAILED', 'GENERATE_GALLERY')).toBe('GENERATING_GALLERY');
    expect(transition('PAYMENT_FAILED', 'PAYMENT_CONFIRMED')).toBe('PAYMENT_SUCCESS');
    expect(nextState('EDITING', 'FAIL')).toBe('ERROR');
    expect(nextState('FINISHED', 'FAIL')).toBeNull();
  });

  it('maps every state to a prototype screen', () => {
    for (const s of SESSION_STATES) expect(screenForState(s)).toMatch(/^(welcome|pay|ready|session|review|tpl|pick|edit|final|print|qr|thanks|error)$/);
    expect(screenForState('COUNTDOWN')).toBe('session');
    expect(screenForState('QR_READY')).toBe('qr');
  });

  it('classifies paid states', () => {
    expect(isPaid('WAITING_PAYMENT')).toBe(false);
    expect(isPaid('EDITING')).toBe(true);
    expect(isPaid('FINISHED')).toBe(true);
  });
});
