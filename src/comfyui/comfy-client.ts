export interface ComfyDiagnostics { httpStatus?: number; upstreamCode?: string; nodeId?: string; errorType?: string }
export class ComfyError extends Error {
  constructor(public readonly code: string, message: string, public readonly uncertain?: boolean, public readonly details?: ComfyDiagnostics) {
    super(message);
    this.name = 'ComfyError';
  }
}

export interface ComfyOutput {
  filename: string;
  subfolder: string;
  type: string;
  nodeId?: string;
}

type QueueItem = { promptId: string; marker?: string };
type History = { state: 'missing' | 'running' | 'succeeded' | 'failed'; outputs: ComfyOutput[]; error?: ComfyDiagnostics };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ComfyError('INVALID_RESPONSE', 'Unrecognized ComfyUI response');
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

function safePath(value: string, filename = false): boolean {
  return !/[\\\x00-\x1f:]/.test(value) && !value.startsWith('/') &&
    (!filename || (value.length > 0 && !value.includes('/'))) &&
    !value.split('/').some((part) => part === '.' || part === '..');
}

function descriptor(value: unknown): ComfyOutput {
  if (!record(value) || typeof value.filename !== 'string' || typeof value.subfolder !== 'string' ||
      typeof value.type !== 'string' || !['input', 'output', 'temp'].includes(value.type) ||
      !safePath(value.filename, true) || !safePath(value.subfolder)) invalid();
  return { filename: value.filename, subfolder: value.subfolder, type: value.type };
}

function tuple(value: unknown): QueueItem {
  if (!Array.isArray(value) || typeof value[1] !== 'string' || !record(value[3])) invalid();
  const marker = value[3].hailuoAttemptId;
  if (marker !== undefined && typeof marker !== 'string') invalid();
  return { promptId: value[1], ...(typeof marker === 'string' ? { marker } : {}) };
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly headers: Headers;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowedGpuModels?: readonly string[];

  constructor(options: { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch; timeoutMs?: number; allowedGpuModels?: readonly string[] }) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new ComfyError('INVALID_CONFIG', 'Invalid ComfyUI base URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ComfyError('INVALID_CONFIG', 'Invalid ComfyUI base URL');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    try { this.headers = new Headers(options.headers); } catch { throw new ComfyError('INVALID_CONFIG', 'Invalid ComfyUI headers'); }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.allowedGpuModels = options.allowedGpuModels;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ComfyError('INVALID_CONFIG', 'Invalid timeout');
  }

  private async request(path: string, body?: object | FormData, submitting = false, streaming = false): Promise<Response> {
    const headers = new Headers(this.headers);
    const multipart = body instanceof FormData;
    if (multipart) headers.delete('content-type');
    else if (body !== undefined) headers.set('content-type', 'application/json');
    let serialized: string | FormData | undefined;
    try { serialized = multipart ? body : body === undefined ? undefined : JSON.stringify(body); }
    catch { throw new ComfyError('INVALID_INPUT', 'Request cannot be serialized', false); }
    let response: Response;
    const headerController = streaming ? new AbortController() : undefined;
    const headerTimer = headerController ? setTimeout(() => headerController.abort(), this.timeoutMs) : undefined;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', headers, body: serialized,
        redirect: 'error', signal: headerController?.signal ?? AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ComfyError(submitting ? 'SUBMISSION_UNKNOWN' : 'TRANSPORT_ERROR',
        submitting ? 'Submission outcome unknown; reconcile before any further action' : 'ComfyUI request failed', submitting);
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
    }
    if (!response.ok) {
      const details: ComfyDiagnostics = { httpStatus: response.status };
      const reader = response.body?.getReader();
      if (reader) {
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 65_536) { await reader.cancel(); break; }
            chunks.push(chunk.value);
          }
          if (size <= 65_536) {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (record(body)) {
              if (record(body.error)) details.errorType = safeIdentifier(body.error.type);
              if (record(body.node_errors)) {
                const first = Object.entries(body.node_errors)[0];
                details.nodeId = safeIdentifier(first?.[0]);
                const errors = first && record(first[1]) && first[1].errors;
                if (Array.isArray(errors) && record(errors[0])) details.errorType = safeIdentifier(errors[0].type) ?? details.errorType;
              }
            }
          }
        } catch {} finally { reader.releaseLock(); }
      }
      const rejected = submitting && response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new ComfyError(submitting ? rejected ? 'SUBMISSION_REJECTED' : 'SUBMISSION_UNKNOWN' : 'HTTP_ERROR',
        `ComfyUI HTTP ${response.status}`, submitting ? !rejected : undefined, details);
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { return invalid(); }
  }

  async health(): Promise<void> {
    const value = await this.json(await this.request('/system_stats'));
    if (!record(value)) invalid();
    if (this.allowedGpuModels) {
      if (!Array.isArray(value.devices) || !value.devices.length || value.devices.some(device => !record(device) || typeof device.name !== 'string' ||
        !this.allowedGpuModels!.some(model => new RegExp(`\\b${model}\\b`).test(device.name as string)))) {
        throw new ComfyError('GPU_NOT_ALLOWED', 'Only the registered RTX 5090/4090 GPU is allowed');
      }
    }
  }

  async queue(): Promise<{ running: QueueItem[]; pending: QueueItem[] }> {
    const value = await this.json(await this.request('/queue'));
    if (!record(value) || !Array.isArray(value.queue_running) || !Array.isArray(value.queue_pending)) invalid();
    return { running: value.queue_running.map(tuple), pending: value.queue_pending.map(tuple) };
  }

  async upload(input: { bytes: Uint8Array; filename: string; contentType: string; subfolder: string }): Promise<{ name: string; subfolder: string; type: string }> {
    if (!safePath(input.filename, true) || !safePath(input.subfolder)) throw new ComfyError('INVALID_INPUT', 'Unsafe upload path');
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(input.bytes)], { type: input.contentType }), input.filename);
    form.append('type', 'input');
    form.append('subfolder', input.subfolder);
    const value = await this.json(await this.request('/upload/image', form));
    if (!record(value)) invalid();
    const output = descriptor({ ...value, filename: value.name });
    if (output.type !== 'input' || output.subfolder !== input.subfolder) invalid();
    return { name: output.filename, subfolder: output.subfolder, type: output.type };
  }

  async submit(input: { graph: Record<string, unknown>; attemptId: string; promptId: string }): Promise<{ promptId: string }> {
    if (!input.attemptId || !input.promptId) throw new ComfyError('INVALID_INPUT', 'Submission identifiers are required', false);
    const response = await this.request('/prompt', {
      prompt: input.graph, extra_data: { hailuoAttemptId: input.attemptId }, prompt_id: input.promptId, client_id: input.attemptId
    }, true);
    try {
      const value = await this.json(response);
      if (!record(value) || typeof value.prompt_id !== 'string' || !value.prompt_id.trim() || /[\x00-\x1f\x7f]/.test(value.prompt_id)) invalid();
      return { promptId: value.prompt_id };
    } catch {
      throw new ComfyError('SUBMISSION_UNKNOWN', 'Submission acknowledgement unknown; reconcile before any further action', true);
    }
  }

  async findAttempt(attemptId: string): Promise<{ promptId: string } | undefined> {
    if (!attemptId) throw new ComfyError('INVALID_INPUT', 'Attempt identifier is required');
    const queue = await this.queue();
    const matches = new Set([...queue.running, ...queue.pending].filter((item) => item.marker === attemptId).map((item) => item.promptId));
    const history = await this.json(await this.request('/history?max_items=1000'));
    if (!record(history)) invalid();
    for (const entry of Object.values(history)) {
      if (!record(entry) || !Array.isArray(entry.prompt)) invalid();
      const item = tuple(entry.prompt);
      if (item.marker === attemptId) matches.add(item.promptId);
    }
    if (matches.size > 1) throw new ComfyError('AMBIGUOUS_ATTEMPT', 'Multiple prompts match this attempt');
    const promptId = [...matches][0];
    return promptId === undefined ? undefined : { promptId };
  }

  async history(promptId: string): Promise<History> {
    const value = await this.json(await this.request('/history/' + encodeURIComponent(promptId)));
    if (!record(value)) invalid();
    if (!Object.hasOwn(value, promptId)) return { state: 'missing', outputs: [] };
    const entry = value[promptId];
    if (!record(entry) || !record(entry.status) || typeof entry.status.completed !== 'boolean') invalid();
    const status = entry.status;
    if (status.status_str === 'error') {
      const failure = Array.isArray(status.messages) ? status.messages.find(message => Array.isArray(message) && message[0] === 'execution_error') : undefined;
      const data = Array.isArray(failure) && record(failure[1]) ? failure[1] : undefined;
      return { state: 'failed', outputs: [], ...(data ? { error: { nodeId: safeIdentifier(data.node_id), errorType: safeIdentifier(data.exception_type) } } : {}) };
    }
    if (status.status_str !== 'success') invalid();
    if (!status.completed) return { state: 'running', outputs: [] };
    if (!record(entry.outputs)) invalid();
    const outputs: ComfyOutput[] = [];
    for (const [nodeId, node] of Object.entries(entry.outputs)) {
      if (!record(node)) invalid();
      for (const key of ['images', 'gifs', 'videos', 'audio']) {
        if (!Object.hasOwn(node, key)) continue;
        if (!Array.isArray(node[key])) invalid();
        for (const output of node[key]) outputs.push({ ...descriptor(output), nodeId });
      }
    }
    if (outputs.length === 0) invalid();
    return { state: 'succeeded', outputs };
  }

  async download(output: ComfyOutput): Promise<Response> {
    const file = descriptor(output);
    return this.request('/view?' + new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type }), undefined, false, true);
  }

  async interrupt(promptId: string): Promise<void> {
    if (!promptId) throw new ComfyError('INVALID_INPUT', 'Prompt identifier is required');
    await this.request('/interrupt', { prompt_id: promptId });
  }

  async removeQueued(promptId: string): Promise<void> {
    if (!promptId) throw new ComfyError('INVALID_INPUT', 'Prompt identifier is required');
    await this.request('/queue', { delete: [promptId] });
  }
}
