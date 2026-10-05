import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Printer abstraction. The server's persistent print queue talks to a
 * PrinterProvider; it never fires and forgets: every job is tracked until the
 * provider reports completed / failed.
 */

export type PrinterState = 'ready' | 'printing' | 'offline' | 'paper_out' | 'ink_error' | 'error' | 'unknown';

export interface PrinterStatus {
  state: PrinterState;
  name: string;
  driver: string;
  message: string;
  queueLength?: number;
  updatedAt: string;
}

export type PrinterJobState = 'queued' | 'printing' | 'completed' | 'failed';

export interface ProviderJobStatus {
  state: PrinterJobState;
  progress: number;
  error?: string;
  errorCode?: PrinterErrorCode;
}

export interface PrintJob {
  id: string;
  printer: string;
  copies: number;
  file: string;
  submittedAt: Date;
}

export interface PrintOptions {
  widthPx: number;
  heightPx: number;
  dpi: number;
  documentName?: string;
}

export interface PrinterProvider {
  readonly driver: string;
  getStatus(): Promise<PrinterStatus>;
  print(file: string, copies: number, options?: PrintOptions): Promise<PrintJob>;
  getJobStatus(jobId: string): Promise<ProviderJobStatus>;
  cancel(jobId: string): Promise<void>;
}

export type PrinterErrorCode = 'PRINTER_OFFLINE' | 'PRINTER_PAPER_OUT' | 'PRINTER_INK_ERROR' | 'PRINT_FAILED' | 'PRINTER_NOT_FOUND';

export class PrinterError extends Error {
  constructor(
    readonly code: PrinterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PrinterError';
  }
}

export function stateToError(state: PrinterState): PrinterErrorCode | null {
  switch (state) {
    case 'offline':
      return 'PRINTER_OFFLINE';
    case 'paper_out':
      return 'PRINTER_PAPER_OUT';
    case 'ink_error':
      return 'PRINTER_INK_ERROR';
    case 'error':
      return 'PRINT_FAILED';
    default:
      return null;
  }
}

const iso = () => new Date().toISOString();

// ------------------------------------------------------------------ mock

export type MockPrinterFault = 'offline' | 'paper_out' | 'ink_error' | 'fail_next' | null;

/**
 * Mock printer: copies the print file to a spool folder (so you can open the
 * exact page that would have been printed) and simulates progress.
 */
export class MockPrinterProvider implements PrinterProvider {
  readonly driver = 'mock';
  private fault: MockPrinterFault = null;
  private jobs = new Map<string, { start: number; durationMs: number; fail: boolean; cancelled: boolean }>();

  constructor(private readonly opts: { spoolDir: string; secondsPerCopy?: number; name?: string }) {}

  simulateFault(f: MockPrinterFault) {
    this.fault = f;
  }

  get currentFault() {
    return this.fault;
  }

  async getStatus(): Promise<PrinterStatus> {
    const busy = [...this.jobs.values()].some((j) => !j.cancelled && Date.now() - j.start < j.durationMs);
    const state: PrinterState =
      this.fault === 'offline' ? 'offline' : this.fault === 'paper_out' ? 'paper_out' : this.fault === 'ink_error' ? 'ink_error' : busy ? 'printing' : 'ready';
    const message = { ready: 'Ready', printing: 'Printing', offline: 'Printer offline', paper_out: 'Paper empty', ink_error: 'Ribbon / ink error', error: 'Error', unknown: 'Unknown' }[state];
    return { state, name: this.opts.name ?? 'Mock Printer', driver: this.driver, message, queueLength: this.jobs.size, updatedAt: iso() };
  }

  async print(file: string, copies: number): Promise<PrintJob> {
    const st = await this.getStatus();
    const code = stateToError(st.state);
    if (code) throw new PrinterError(code, st.message);
    await fs.mkdir(this.opts.spoolDir, { recursive: true });
    const id = `mock-${Date.now()}-${randomBytes(3).toString('hex')}`;
    await fs.copyFile(file, path.join(this.opts.spoolDir, `${id}_x${copies}${path.extname(file)}`));
    const fail = this.fault === 'fail_next';
    if (fail) this.fault = null;
    const seconds = Math.max(1, (this.opts.secondsPerCopy ?? 2) * copies);
    this.jobs.set(id, { start: Date.now(), durationMs: seconds * 1000, fail, cancelled: false });
    return { id, printer: this.opts.name ?? 'Mock Printer', copies, file, submittedAt: new Date() };
  }

  async getJobStatus(jobId: string): Promise<ProviderJobStatus> {
    const j = this.jobs.get(jobId);
    if (!j) return { state: 'failed', progress: 0, error: 'Unknown job', errorCode: 'PRINT_FAILED' };
    if (j.cancelled) return { state: 'failed', progress: 0, error: 'Cancelled', errorCode: 'PRINT_FAILED' };
    const p = Math.min(1, (Date.now() - j.start) / j.durationMs);
    if (j.fail && p > 0.4) return { state: 'failed', progress: Math.round(p * 100), error: 'Simulated print failure', errorCode: 'PRINT_FAILED' };
    if (this.fault === 'paper_out' && p < 1) return { state: 'failed', progress: Math.round(p * 100), error: 'Paper empty', errorCode: 'PRINTER_PAPER_OUT' };
    if (this.fault === 'offline' && p < 1) return { state: 'failed', progress: Math.round(p * 100), error: 'Printer offline', errorCode: 'PRINTER_OFFLINE' };
    if (p >= 1) {
      return { state: 'completed', progress: 100 };
    }
    return { state: 'printing', progress: Math.round(p * 100) };
  }

  async cancel(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j) j.cancelled = true;
  }
}

// ------------------------------------------------------------------ system (Windows spooler / CUPS)

function exec(bin: string, args: string[], timeoutMs = 60000, input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => {
      child.kill();
      reject(new PrinterError('PRINT_FAILED', `${bin} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(new PrinterError('PRINTER_NOT_FOUND', `${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function powershell(script: string, timeoutMs = 60000) {
  // Script is passed via stdin to avoid quoting problems and command-line length limits.
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], timeoutMs, script);
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Maps Windows PrinterStatus (Get-Printer) to our states. */
export function mapWindowsPrinterStatus(status: string, workOffline: boolean): PrinterState {
  const s = status.toLowerCase();
  if (workOffline || s.includes('offline') || s.includes('notavailable')) return 'offline';
  if (s.includes('paperout') || s.includes('paperproblem') || s.includes('paperjam') || s.includes('manualfeed')) return 'paper_out';
  if (s.includes('notoner') || s.includes('tonerlow')) return 'ink_error';
  if (s.includes('error') || s.includes('userintervention') || s.includes('dooropen') || s.includes('outofmemory') || s.includes('paused')) return 'error';
  if (s.includes('printing') || s.includes('processing') || s.includes('busy') || s.includes('ioactive')) return 'printing';
  if (s === '' || s.includes('normal') || s === '0' || s.includes('idle') || s.includes('waiting') || s.includes('warmingup') || s.includes('initializ')) return 'ready';
  return 'unknown';
}

/** Maps Windows JobStatus flags (Get-PrintJob) to failure codes. */
export function mapWindowsJobStatus(status: string): PrinterErrorCode | null {
  const s = status.toLowerCase();
  if (s.includes('paperout')) return 'PRINTER_PAPER_OUT';
  if (s.includes('offline')) return 'PRINTER_OFFLINE';
  if (s.includes('error') || s.includes('blocked') || s.includes('userintervention')) return 'PRINT_FAILED';
  return null;
}

/**
 * Uses the operating system print queue.
 *  - Windows: a PowerShell/.NET System.Drawing PrintDocument job (no dialogs, exact
 *    page fill, copies), tracked through Get-PrintJob / Get-Printer.
 *  - Linux / macOS: CUPS `lp` + `lpstat`.
 */
export class SystemPrinterProvider implements PrinterProvider {
  readonly driver = 'system';
  private seen = new Map<string, { seenInQueue: boolean; submitted: number; copies: number }>();

  constructor(private readonly opts: { printerName: string; secondsPerCopy: number; platform?: NodeJS.Platform }) {}

  private get platform() {
    return this.opts.platform ?? process.platform;
  }

  async getStatus(): Promise<PrinterStatus> {
    const name = this.opts.printerName;
    if (!name) return { state: 'offline', name: '(not configured)', driver: this.driver, message: 'PRINTER_NAME is not set', updatedAt: iso() };
    try {
      if (this.platform === 'win32') {
        const { stdout, code } = await powershell(
          `$p = Get-Printer -Name ${psq(name)} -ErrorAction Stop; $j = @(Get-PrintJob -PrinterName ${psq(name)} -ErrorAction SilentlyContinue).Count; ` +
            `[pscustomobject]@{ status = [string]$p.PrinterStatus; offline = [bool]$p.WorkOffline; jobs = $j } | ConvertTo-Json -Compress`,
          15000,
        );
        if (code !== 0 || !stdout.trim()) return { state: 'offline', name, driver: this.driver, message: 'Printer not found', updatedAt: iso() };
        const r = JSON.parse(stdout.trim()) as { status: string; offline: boolean; jobs: number };
        const state = mapWindowsPrinterStatus(r.status, r.offline);
        return { state, name, driver: this.driver, message: r.status || 'Normal', queueLength: r.jobs, updatedAt: iso() };
      }
      const { stdout, code } = await exec('lpstat', ['-p', name], 10000);
      if (code !== 0) return { state: 'offline', name, driver: this.driver, message: 'Printer not found', updatedAt: iso() };
      const s = stdout.toLowerCase();
      const state: PrinterState = s.includes('disabled') ? 'offline' : s.includes('printing') ? 'printing' : s.includes('idle') ? 'ready' : 'unknown';
      return { state, name, driver: this.driver, message: stdout.trim().split('\n')[0] ?? '', updatedAt: iso() };
    } catch (err) {
      return { state: 'unknown', name, driver: this.driver, message: (err as Error).message, updatedAt: iso() };
    }
  }

  async print(file: string, copies: number, options?: PrintOptions): Promise<PrintJob> {
    const name = this.opts.printerName;
    if (!name) throw new PrinterError('PRINTER_NOT_FOUND', 'PRINTER_NAME is not configured');
    const st = await this.getStatus();
    const code = stateToError(st.state);
    if (code) throw new PrinterError(code, st.message);
    await fs.access(file);
    const docName = options?.documentName ?? `RobotPhotobooth-${Date.now()}-${randomBytes(3).toString('hex')}`;

    if (this.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$img = [System.Drawing.Image]::FromFile(${psq(path.resolve(file))})
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.DocumentName = ${psq(docName)}
  $doc.PrinterSettings.PrinterName = ${psq(name)}
  if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found" }
  $doc.PrinterSettings.Copies = ${Math.max(1, Math.min(99, Math.trunc(copies)))}
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
  $doc.OriginAtMargins = $false
  $landscapeImg = $img.Width -gt $img.Height
  $doc.DefaultPageSettings.Landscape = $landscapeImg
  $doc.add_PrintPage({
    param($s, $e)
    $b = $e.PageBounds
    $ratio = [Math]::Max($b.Width / $img.Width, $b.Height / $img.Height)
    $w = $img.Width * $ratio; $h = $img.Height * $ratio
    $x = ($b.Width - $w) / 2; $y = ($b.Height - $h) / 2
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.DrawImage($img, [single]$x, [single]$y, [single]$w, [single]$h)
    $e.HasMorePages = $false
  })
  $doc.Print()
  Write-Output 'SPOOLED'
} finally { $img.Dispose() }
`;
      const r = await powershell(script, 120000);
      if (r.code !== 0 || !r.stdout.includes('SPOOLED')) throw new PrinterError('PRINT_FAILED', r.stderr.trim().split('\n')[0] || 'Spooling failed');
      this.seen.set(docName, { seenInQueue: false, submitted: Date.now(), copies });
      return { id: docName, printer: name, copies, file, submittedAt: new Date() };
    }

    const args = ['-d', name, '-n', String(copies), '-o', 'fit-to-page', '-t', docName];
    if (options) args.push('-o', `ppi=${options.dpi}`);
    const r = await exec('lp', [...args, file], 30000);
    if (r.code !== 0) throw new PrinterError('PRINT_FAILED', r.stderr.trim() || 'lp failed');
    const id = /request id is (\S+)/.exec(r.stdout)?.[1] ?? docName;
    this.seen.set(id, { seenInQueue: false, submitted: Date.now(), copies });
    return { id, printer: name, copies, file, submittedAt: new Date() };
  }

  async getJobStatus(jobId: string): Promise<ProviderJobStatus> {
    const meta = this.seen.get(jobId) ?? { seenInQueue: false, submitted: Date.now(), copies: 1 };
    const expected = Math.max(5, this.opts.secondsPerCopy * meta.copies) * 1000;
    const elapsed = Date.now() - meta.submitted;
    const estimate = Math.min(95, Math.round((elapsed / expected) * 100));
    const name = this.opts.printerName;

    if (this.platform === 'win32') {
      const { stdout } = await powershell(
        `$j = Get-PrintJob -PrinterName ${psq(name)} -ErrorAction SilentlyContinue | Where-Object { $_.DocumentName -eq ${psq(jobId)} } | Select-Object -First 1; ` +
          `if ($j) { [pscustomobject]@{ found = $true; status = [string]$j.JobStatus } | ConvertTo-Json -Compress } else { '{"found":false}' }`,
        15000,
      );
      const r = JSON.parse(stdout.trim() || '{"found":false}') as { found: boolean; status?: string };
      if (r.found) {
        meta.seenInQueue = true;
        this.seen.set(jobId, meta);
        const err = mapWindowsJobStatus(r.status ?? '');
        if (err) return { state: 'failed', progress: estimate, error: r.status, errorCode: err };
        return { state: (r.status ?? '').toLowerCase().includes('print') ? 'printing' : 'queued', progress: estimate };
      }
      // Not in the queue any more: finished (or spooled too quickly to observe).
      const st = await this.getStatus();
      const code = stateToError(st.state);
      if (code && !meta.seenInQueue) return { state: 'failed', progress: 0, error: st.message, errorCode: code };
      // Keep showing progress until the expected physical print time has elapsed.
      if (elapsed < expected * 0.6) return { state: 'printing', progress: estimate };
      return { state: 'completed', progress: 100 };
    }

    const { stdout } = await exec('lpstat', ['-o', name], 10000).catch(() => ({ stdout: '' }) as { stdout: string });
    if (stdout.includes(jobId)) {
      meta.seenInQueue = true;
      return { state: 'printing', progress: estimate };
    }
    const st = await this.getStatus();
    const code = stateToError(st.state);
    if (code && !meta.seenInQueue) return { state: 'failed', progress: 0, error: st.message, errorCode: code };
    return elapsed < expected * 0.6 ? { state: 'printing', progress: estimate } : { state: 'completed', progress: 100 };
  }

  async cancel(jobId: string): Promise<void> {
    const name = this.opts.printerName;
    if (this.platform === 'win32') {
      await powershell(
        `Get-PrintJob -PrinterName ${psq(name)} -ErrorAction SilentlyContinue | Where-Object { $_.DocumentName -eq ${psq(jobId)} } | Remove-PrintJob -ErrorAction SilentlyContinue`,
        15000,
      );
    } else {
      await exec('cancel', [jobId], 10000).catch(() => undefined);
    }
    this.seen.delete(jobId);
  }

  /** List installed printers (for the admin panel). */
  static async listPrinters(platform: NodeJS.Platform = process.platform): Promise<string[]> {
    try {
      if (platform === 'win32') {
        const { stdout } = await powershell('Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress', 15000);
        const v = JSON.parse(stdout.trim() || '[]');
        return Array.isArray(v) ? v : [v];
      }
      const { stdout } = await exec('lpstat', ['-e'], 10000);
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

export interface PrinterConfig {
  driver: 'mock' | 'system';
  name: string;
  secondsPerCopy: number;
  spoolDir: string;
}

export function createPrinter(cfg: PrinterConfig): PrinterProvider {
  if (cfg.driver === 'system') return new SystemPrinterProvider({ printerName: cfg.name, secondsPerCopy: cfg.secondsPerCopy });
  return new MockPrinterProvider({ spoolDir: cfg.spoolDir, secondsPerCopy: Math.min(3, cfg.secondsPerCopy), name: cfg.name || 'Mock Printer' });
}
