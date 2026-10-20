export interface AigateInstance {
  id: string;
  status: string;
  operationStatus?: string;
  areaName?: string;
  services: Array<{
    host: string;
    port?: number;
    instancePort?: number;
    protocol?: string;
    httpType?: string;
  }>;
}

export class AigateError extends Error {
  constructor(public readonly code: string, message: string, public readonly errCode?: string) {
    super(message);
    this.name = 'AigateError';
  }
}

function invalidResponse(): never {
  throw new AigateError('INVALID_RESPONSE', 'Invalid AIGate response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return invalidResponse();
  }
  return port;
}

export class AigateClient {
  #token: string;
  #fetch: typeof fetch;
  #baseUrl: string;
  #timeoutMs: number;
  #capacityErrorCodes: Set<string>;

  constructor(options: { token: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; capacityErrorCodes?: string[] }) {
    if (typeof options.token !== 'string' || !options.token.trim() || /[\r\n]/.test(options.token)) {
      throw new AigateError('INVALID_ARGUMENT', 'AIGate token is required');
    }
    this.#token = options.token;
    const capacityErrorCodes = options.capacityErrorCodes ?? [];
    if (!Array.isArray(capacityErrorCodes) || capacityErrorCodes.length > 100
      || capacityErrorCodes.some(code => typeof code !== 'string' || this.safeErrorCode(code) === undefined)) {
      throw new AigateError('INVALID_ARGUMENT', 'Invalid AIGate capacity error codes');
    }
    this.#capacityErrorCodes = new Set(capacityErrorCodes);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 2_147_483_647) {
      throw new AigateError('INVALID_ARGUMENT', 'Invalid AIGate timeout');
    }
    try {
      const baseUrl = new URL(options.baseUrl ?? 'https://waas.aigate.cc');
      if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password
        || baseUrl.search || baseUrl.hash) throw new Error();
      this.#baseUrl = baseUrl.toString();
    } catch {
      throw new AigateError('INVALID_ARGUMENT', 'Invalid AIGate base URL');
    }
  }

  async getInstance(instanceId: string): Promise<AigateInstance> {
    const data = await this.request('get', instanceId);
    if (!isRecord(data)) return invalidResponse();
    const rawId = data.instanceId;
    const id = typeof rawId === 'string' ? rawId
      : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : undefined;
    const tools = data.instanceUtilList ?? [];
    if (id !== instanceId || !Array.isArray(tools)) return invalidResponse();
    const operationStatus = data.operationStatus;
    if (operationStatus !== undefined && typeof operationStatus !== 'string') return invalidResponse();
    const status = data.instanceStatus ?? data.status ?? operationStatus;
    if (typeof status !== 'string' || !status.trim()) return invalidResponse();
    const areaName = data.areaName;
    if (areaName !== undefined && areaName !== null && (typeof areaName !== 'string' || !areaName.trim())) return invalidResponse();
    const services = tools.map((service): AigateInstance['services'][number] => {
      if (!isRecord(service) || typeof service.host !== 'string' || !service.host.trim()) {
        return invalidResponse();
      }
      const result: AigateInstance['services'][number] = { host: service.host };
      for (const key of ['port', 'instancePort'] as const) {
        if (key === 'instancePort' && service[key] === 'null') continue;
        const port = parsePort(service[key]);
        if (port !== undefined) result[key] = port;
      }
      for (const key of ['protocol', 'httpType'] as const) {
        const value = service[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return invalidResponse();
        result[key] = value;
      }
      return result;
    });
    return { id, status, ...(operationStatus === undefined ? {} : { operationStatus }),
      ...(typeof areaName === 'string' ? { areaName } : {}), services };
  }

  async getInstanceStatus(instanceId: string): Promise<string> {
    const status = await this.request('status', instanceId);
    if (typeof status !== 'string' || !status.trim()) return invalidResponse();
    return status;
  }

  async openInstance(instanceId: string): Promise<void> {
    await this.request('open', instanceId);
  }

  async closeInstance(instanceId: string): Promise<void> {
    await this.request('close', instanceId);
  }

  async setGpuIdleShutdown(instanceId: string): Promise<void> {
    await this.request('setTimerStop', instanceId);
  }

  private safeErrorCode(value: unknown): string | undefined {
    const code = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(code)
      || code.toLowerCase().includes(this.#token.toLowerCase())
      || code.toLowerCase().includes(encodeURIComponent(this.#token).toLowerCase())) return undefined;
    return code;
  }

  private async request(action: 'get' | 'status' | 'open' | 'close' | 'setTimerStop', instanceId: string): Promise<unknown> {
    if (typeof instanceId !== 'string' || !/^\d+$/.test(instanceId)) {
      throw new AigateError('INVALID_ARGUMENT', 'AIGate instance ID must be a decimal string');
    }
    const gpuIdleShutdown = action === 'setTimerStop';
    if (gpuIdleShutdown && (!/^(?:0|[1-9]\d{0,18})$/.test(instanceId) || BigInt(instanceId) > 9_223_372_036_854_775_807n)) {
      throw new AigateError('INVALID_ARGUMENT', 'AIGate instance ID must be a canonical non-negative int64 decimal string');
    }
    const url = new URL(`/api/openapi/instance/${action}`, this.#baseUrl);
    if (!gpuIdleShutdown) url.searchParams.set('instanceId', instanceId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AigateError('TIMEOUT', 'AIGate request timed out; outcome unknown'));
        controller.abort();
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        let response: Response;
        try {
          response = await this.#fetch(url, {
            method: gpuIdleShutdown ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${this.#token}`, ...(gpuIdleShutdown ? { 'Content-Type': 'application/json' } : {}) },
            ...(gpuIdleShutdown ? { body: `{"instanceId":${instanceId},"stopType":"2","utilizationRate":10,"leisureTime":30}` } : {}),
            signal: controller.signal,
            redirect: 'error',
            cache: 'no-store'
          });
        } catch {
          throw new AigateError('NETWORK_ERROR', 'AIGate network failure; outcome unknown');
        }
        if (!response.ok) {
          throw new AigateError('HTTP_ERROR', `AIGate HTTP failure (${response.status})`);
        }
        let text: string;
        try {
          text = await response.text();
        } catch {
          throw new AigateError('NETWORK_ERROR', 'AIGate response interrupted; outcome unknown');
        }
        let body: unknown;
        try {
          body = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
            if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
              && context?.source && /^-?\d+$/.test(context.source)) return context.source;
            return value;
          });
        } catch {
          return invalidResponse();
        }
        if (!isRecord(body) || typeof body.code !== 'number' || !Number.isInteger(body.code)
          || (body.ok !== undefined && typeof body.ok !== 'boolean')) return invalidResponse();
        if (body.code !== 0 || body.ok === false) {
          const errCode = this.safeErrorCode(body.errCode);
          const explicitlyUnavailable = typeof body.msg === 'string' && body.msg.length <= 500 &&
            /(?:显卡|GPU|算力)(?:资源|库存)?(?:不足|已售罄|已售完|暂无库存)|(?:暂无|没有|无)可用(?:的)?(?:GPU|显卡|算力)|(?:GPU|显卡)(?:资源)?(?:暂不可用|暂时不可用)/i.test(body.msg);
          if (action === 'open' && (errCode !== undefined && this.#capacityErrorCodes.has(errCode) || explicitlyUnavailable)) {
            throw new AigateError('CAPACITY_UNAVAILABLE', 'AIGate capacity is unavailable', errCode);
          }
          throw new AigateError('BUSINESS_REJECTED', 'AIGate explicitly rejected the request', errCode);
        }
        if (action === 'status' && typeof body.data !== 'string') return invalidResponse();
        if ((action === 'open' || action === 'close') && body.data !== null && typeof body.data !== 'string') {
          return invalidResponse();
        }
        if (gpuIdleShutdown && body.data !== null && body.data !== true) return invalidResponse();
        return body.data;
      })()]);
    } finally {
      clearTimeout(timer);
    }
  }
}
