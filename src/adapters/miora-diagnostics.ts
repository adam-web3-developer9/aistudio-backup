import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface MioraDiagnosticLogger { info: (fields: Record<string, unknown>, message: string) => void }
export interface MioraDiagnosticContext {
  requestId?: string;
  apiRequestId?: string;
  uploadIntentId?: string;
  itemIndex?: number;
  jobId?: string;
  taskId?: string;
}
type DiagnosticFields = MioraDiagnosticContext & {
  stage?: string; outcome?: string; method?: string; path?: string; route?: string;
  attempt?: number; retry?: number; delayMs?: number; elapsedMs?: number;
  httpStatus?: number; providerCode?: string; code?: string; networkCode?: string;
  cosCode?: string; cosRequestId?: string; retryable?: boolean;
  expectedBytes?: number; bytes?: number; sourceId?: string; dropped?: number; sinkFailures?: number;
};

const identifiers = new Set(['requestId', 'apiRequestId', 'uploadIntentId', 'jobId', 'taskId', 'cosRequestId']);
const labels = new Set(['stage', 'outcome', 'method', 'route', 'providerCode', 'code', 'networkCode', 'cosCode', 'sourceId']);
const numbers = new Set(['itemIndex', 'attempt', 'retry', 'delayMs', 'elapsedMs', 'httpStatus', 'expectedBytes', 'bytes', 'dropped', 'sinkFailures']);
/** No generic error/body/string serializer: only these non-secret fields can leave this boundary. */
export function safeMioraDiagnosticFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (identifiers.has(key) && typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) safe[key] = value;
    else if (labels.has(key) && typeof value === 'string' && /^[A-Za-z0-9 _.-]{1,80}$/.test(value)) safe[key] = value;
    else if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
    else if (key === 'retryable' && typeof value === 'boolean') safe[key] = value;
    else if (key === 'path' && typeof value === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(value.split('?')[0]!)) safe[key] = value.split('?')[0];
  }
  return safe;
}

/** The service logger owns its existing destination/rotation. This queue bounds diagnostic work. */
export class MioraDiagnosticSink {
  private readonly queue: Record<string, unknown>[] = [];
  private scheduled = false;
  private dropped = 0;
  private sinkFailures = 0;
  constructor(private readonly logger: MioraDiagnosticLogger, private readonly capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Diagnostic queue capacity must be positive');
  }
  emit(event: string, fields: DiagnosticFields = {}): void {
    if (!/^miora\.[a-z_.]{1,80}$/.test(event)) return;
    const record = { event, ...safeMioraDiagnosticFields({ ...fields }) };
    if (this.queue.length >= this.capacity) {
      // Retain the newest evidence (including final failures) and account for every discarded record.
      this.queue.shift(); this.dropped++;
    }
    this.queue.push(record);
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => this.flush()); }
  }
  flush(): void {
    this.scheduled = false;
    const batch = this.queue.splice(0, this.capacity);
    if (this.dropped || this.sinkFailures) {
      const fields = { event: 'miora.diagnostics.dropped', dropped: this.dropped, sinkFailures: this.sinkFailures };
      try { this.logger.info(fields, fields.event); this.dropped = 0; this.sinkFailures = 0; }
      catch { this.sinkFailures++; }
    }
    for (const fields of batch) {
      try { this.logger.info(fields, String(fields.event)); }
      catch { this.sinkFailures++; }
    }
  }
}
const contexts = new AsyncLocalStorage<{ sink: MioraDiagnosticSink; context: MioraDiagnosticContext }>();
export function withMioraDiagnostics<T>(sink: MioraDiagnosticSink, context: MioraDiagnosticContext, run: () => T): T {
  return contexts.run({ sink, context: { ...contexts.getStore()?.context, ...context } }, run);
}
export function withMioraDiagnosticContext<T>(context: MioraDiagnosticContext, run: () => T): T {
  const current = contexts.getStore();
  return current ? withMioraDiagnostics(current.sink, context, run) : run();
}
export function mioraDiagnostic(event: string, fields: DiagnosticFields = {}): void {
  const current = contexts.getStore();
  current?.sink.emit(event, { ...current.context, ...fields });
}
export function mioraSourceIdentity(value: string): string {
  try { const url = new URL(value); return createHash('sha256').update(url.origin + url.pathname).digest('hex').slice(0, 24); }
  catch { return 'invalid'; }
}
export function mioraNetworkCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
