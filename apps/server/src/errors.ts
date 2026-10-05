import { InvalidTransitionError } from '@photobooth/shared';
import { ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Application error with a stable code, an HTTP status, a technical message for
 * logs/admin and a friendly Indonesian message that is safe to show on the booth.
 * Stack traces are never sent to clients.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly userMessage?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const USER_MESSAGES: Record<string, string> = {
  MAINTENANCE: 'Booth sedang dalam perawatan. Silakan coba beberapa saat lagi.',
  CAMERA_DISCONNECTED: 'Kamera terputus. Petugas akan segera membantu.',
  CAMERA_CAPTURE_FAILED: 'Foto gagal diambil. Kita coba lagi, ya.',
  ROBOT_TIMEOUT: 'Robot sedang lambat merespons. Kita lanjutkan dari posisi ini.',
  ROBOT_DISCONNECTED: 'Robot terputus. Kita lanjutkan dari posisi ini.',
  PAYMENT_EXPIRED: 'Waktu pembayaran habis. Yuk buat kode QR baru.',
  PAYMENT_API_UNAVAILABLE: 'Layanan pembayaran sedang sibuk. Coba lagi sebentar lagi.',
  STORAGE_FULL: 'Penyimpanan booth penuh. Petugas akan segera membantu.',
  PRINTER_OFFLINE: 'Printer sedang tidak tersambung.',
  PRINTER_PAPER_OUT: 'Kertas printer habis.',
  PRINTER_INK_ERROR: 'Tinta atau ribbon printer bermasalah.',
  PRINT_FAILED: 'Cetakan gagal.',
  BACKEND_UNAVAILABLE: 'Sistem sedang menyambung ulang…',
  INTERNET_LOST: 'Internet terputus. Fotomu tetap aman dan akan diunggah otomatis.',
  INVALID_TRANSITION: 'Sebentar ya, layar sedang diperbarui.',
  SESSION_NOT_FOUND: 'Sesi tidak ditemukan.',
  UNAUTHORIZED: 'Akses ditolak.',
  VALIDATION_ERROR: 'Data tidak valid.',
  RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar.',
  INTERNAL: 'Terjadi kendala. Petugas akan segera membantu.',
};

export function appError(code: string, statusCode: number, message: string, retryable = false): AppError {
  return new AppError(code, statusCode, message, USER_MESSAGES[code], retryable);
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    const level = err.statusCode >= 500 ? 'error' : 'warn';
    req.log[level]({ err: { code: err.code, message: err.message } }, 'request_failed');
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, userMessage: err.userMessage, retryable: err.retryable } });
  }
  if (err instanceof InvalidTransitionError) {
    req.log.warn({ from: err.from, event: err.event }, 'invalid_transition');
    return reply.status(409).send({ error: { code: 'INVALID_TRANSITION', message: err.message, userMessage: USER_MESSAGES.INVALID_TRANSITION } });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), userMessage: USER_MESSAGES.VALIDATION_ERROR },
    });
  }
  const fe = err as FastifyError;
  if (fe.statusCode === 429) {
    return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', userMessage: USER_MESSAGES.RATE_LIMITED, retryable: true } });
  }
  if (fe.validation || (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500)) {
    return reply.status(fe.statusCode ?? 400).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: fe.message } });
  }
  req.log.error({ err }, 'unhandled_error');
  return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error', userMessage: USER_MESSAGES.INTERNAL, retryable: true } });
}
