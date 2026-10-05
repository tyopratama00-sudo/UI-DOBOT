import { EventEmitter } from 'node:events';

/** In-process pub/sub used to push session snapshots to SSE clients. */
export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(200);
  }

  emitSession(sessionId: string) {
    this.ee.emit(`session:${sessionId}`);
    this.ee.emit('session:*', sessionId);
  }

  onSession(sessionId: string, cb: () => void): () => void {
    const k = `session:${sessionId}`;
    this.ee.on(k, cb);
    return () => this.ee.off(k, cb);
  }

  onAnySession(cb: (sessionId: string) => void): () => void {
    this.ee.on('session:*', cb);
    return () => this.ee.off('session:*', cb);
  }

  emitSettings() {
    this.ee.emit('settings');
  }

  onSettings(cb: () => void): () => void {
    this.ee.on('settings', cb);
    return () => this.ee.off('settings', cb);
  }
}
