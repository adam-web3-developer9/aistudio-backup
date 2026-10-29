export interface AigateInstance {
  id: string;
  status: string;
  operationStatus?: string;
  areaName?: string;
  instanceName?: string;
  count?: number;
  imageId?: string;
  imageType?: string;
  chargeType?: string;
  services: Array<{
    host: string;
    port?: number;
    instancePort?: number;
    protocol?: string;
    httpType?: string;
  }>;
}

export interface AigateSshConnection {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface AigateSku {
  areaName: string;
  skuName: string;
  price: string;
  vmSize: string;
  cpuMf: string;
  cpuCore: number;
  memorySize: string;
  sysDiskSize: string;
  maxGpuCount: number;
}

export type AigateCreateRequest = {
  areaName: string;
  count: number;
  imageId: string;
  imageType: '2' | '3';
} & ({ skuName: string; gpuModel?: never } | { gpuModel: string; skuName?: never });

export interface AigatePageRequest {
  current: number;
  pageSize: number;
  operationStatus?: string | null;
  instanceName?: string;
}

export interface AigateInstancePage {
  total: number;
  records: AigateInstance[];
}

export interface AigateReconcileOptions {
  maxPages: number;
  pageSize?: number;
  operationStatus?: string | null;
}

export interface AigateReconcileResult {
  records: AigateInstance[];
  complete: boolean;
  pagesScanned: number;
}

// 服务端只保留“可行动的分类”，不保存平台原始 msg：原始正文里可能混着 token、HTML 或超长内容。
// 分类足够让调度层和客户端给出明确指引（例如去充值），又不扩大泄露面。
export type AigateRejectionReason = 'INSUFFICIENT_BALANCE' | 'INSTANCE_START_REJECTED';

export class AigateError extends Error {
  constructor(public readonly code: string, message: string, public readonly errCode?: string,
    public readonly uncertain = false, public readonly reason?: AigateRejectionReason,
    public readonly requestSent?: false) {
    super(message);
    this.name = 'AigateError';
  }
}

function rejectionReason(msg: string, action: string): AigateRejectionReason | undefined {
  if (/余额|欠费|充值|欠款|insufficient\s+balance|account\s+balance|arrears/i.test(msg)) return 'INSUFFICIENT_BALANCE';
  if (action === 'open' || action === 'start' || action === 'create') return 'INSTANCE_START_REJECTED';
  return undefined;
}

function invalidResponse(uncertain = false): never {
  throw new AigateError('INVALID_RESPONSE', 'Invalid AIGate response', undefined, uncertain);
}

function isInt64(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
    && /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function responseId(value: unknown, uncertain = false): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (!isInt64(id)) return invalidResponse(uncertain);
  return id;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function invalidArgument(): never {
  throw new AigateError('INVALID_ARGUMENT', 'Invalid AIGate request parameters');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failedBeforeSend(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = isRecord(error.cause) ? error.cause.code : error.code;
  // These failures happen before an HTTP connection exists. Socket resets, body
  // timeouts and generic fetch failures can follow submission and stay uncertain.
  return typeof code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const port = typeof value === 'string' && value === value.trim() && /^\d+$/.test(value) ? Number(value) : value;
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
    const instance = this.parseInstance(data);
    if (instance.id !== instanceId) return invalidResponse();
    return instance;
  }

  async getSshConnection(instanceId: string): Promise<AigateSshConnection> {
    if (!isInt64(instanceId)) return invalidArgument();
    const data = await this.request('get', instanceId).catch((error: unknown) => {
      throw new AigateError(error instanceof AigateError ? error.code : 'NETWORK_ERROR',
        'AIGate SSH connection request failed');
    });
    const instance = this.parseInstance(data);
    if (instance.id !== instanceId || instance.status !== '2'
      || !isRecord(data) || ['operationStatus', 'instanceStatus', 'status'].some(key => data[key] !== undefined && data[key] !== '2')
      || !Array.isArray(data.instanceUtilList)) return invalidResponse();
    const tools = data.instanceUtilList.filter((tool: unknown): tool is Record<string, unknown> =>
      isRecord(tool) && typeof tool.name === 'string' && tool.name.toLowerCase() === 'ssh');
    if (tools.length !== 1) return invalidResponse();
    const tool = tools[0]!;
    const host = tool.host;
    const port = parsePort(tool.instancePort);
    const username = tool.userAccount;
    const password = tool.password;
    if (tool.protocol !== 'TCP' || parsePort(tool.port) !== 22 || port === undefined
      || typeof host !== 'string' || host.length > 253 || host !== host.trim()
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+waas\.aigate\.cc$/i.test(host)
      || !nonEmpty(username) || username.length > 256 || /[\r\n\0]/.test(username)
      || !nonEmpty(password) || password.length > 4096 || /[\r\n\0]/.test(password)) return invalidResponse();
    return { host, port, username, password };
  }

  private parseInstance(data: unknown): AigateInstance {
    if (!isRecord(data)) return invalidResponse();
    const rawId = data.instanceId;
    const id = typeof rawId === 'string' ? rawId
      : typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : undefined;
    const tools = data.instanceUtilList ?? [];
    if (id === undefined || !isInt64(id) || !Array.isArray(tools)) return invalidResponse();
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
    const metadata: Partial<AigateInstance> = {};
    for (const key of ['instanceName', 'imageType', 'chargeType'] as const) {
      const value = data[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') return invalidResponse();
      metadata[key] = value;
    }
    if (data.imageId !== undefined && data.imageId !== null) metadata.imageId = responseId(data.imageId);
    if (data.count !== undefined && data.count !== null) {
      if (!positiveInteger(data.count, 8)) return invalidResponse();
      metadata.count = data.count;
    }
    return { ...metadata, id, status, ...(operationStatus === undefined ? {} : { operationStatus }),
      ...(typeof areaName === 'string' ? { areaName } : {}), services };
  }

  async skuList(areaName: string): Promise<AigateSku[]> {
    if (!nonEmpty(areaName)) return invalidArgument();
    const data = await this.request('skuList', undefined, { areaName });
    if (!Array.isArray(data)) return invalidResponse();
    return data.map(item => {
      if (!isRecord(item)) return invalidResponse();
      const result = {} as AigateSku;
      for (const key of ['areaName', 'skuName', 'price', 'vmSize', 'cpuMf', 'memorySize', 'sysDiskSize'] as const) {
        if (!nonEmpty(item[key])) return invalidResponse();
        result[key] = item[key];
      }
      for (const key of ['cpuCore', 'maxGpuCount'] as const) {
        if (!positiveInteger(item[key])) return invalidResponse();
        result[key] = item[key];
      }
      return result;
    });
  }

  async createInstance(request: AigateCreateRequest): Promise<string> {
    if (!isRecord(request) || !nonEmpty(request.areaName) || !positiveInteger(request.count, 8)
      || !isInt64(request.imageId) || !['2', '3'].includes(request.imageType)
      || (request.skuName !== undefined) === (request.gpuModel !== undefined)
      || !nonEmpty(request.skuName ?? request.gpuModel)) return invalidArgument();
    const fields = { areaName: request.areaName, count: request.count, imageType: request.imageType,
      ...(request.skuName !== undefined ? { skuName: request.skuName } : { gpuModel: request.gpuModel }) };
    const body = JSON.stringify(fields).slice(0, -1) + ',"imageId":' + request.imageId + '}';
    const data = await this.request('start', undefined, undefined, body);
    if (!isRecord(data)) return invalidResponse(true);
    return responseId(data.instanceId, true);
  }

  async pageInstances(request: AigatePageRequest): Promise<AigateInstancePage> {
    if (!isRecord(request) || !positiveInteger(request.current) || !positiveInteger(request.pageSize, 20)
      || (request.operationStatus !== undefined && request.operationStatus !== null && !nonEmpty(request.operationStatus))
      || (request.instanceName !== undefined && !nonEmpty(request.instanceName))) return invalidArgument();
    const data = await this.request('page', undefined, undefined, JSON.stringify({ current: request.current,
      pageSize: request.pageSize, ...(request.operationStatus === undefined ? {} : { operationStatus: request.operationStatus }) }));
    if (!isRecord(data) || typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < 0
      || !Array.isArray(data.records) || data.records.length > request.pageSize) return invalidResponse();
    const records = data.records.map(item => this.parseInstance(item));
    return { total: data.total, records: request.instanceName === undefined ? records
      : records.filter(item => item.instanceName === request.instanceName) };
  }

  async findInstancesByName(name: string, options: AigateReconcileOptions): Promise<AigateReconcileResult> {
    if (!nonEmpty(name) || !isRecord(options) || !positiveInteger(options.maxPages, 100)
      || !positiveInteger(options.pageSize ?? 20, 20)) return invalidArgument();
    const pageSize = options.pageSize ?? 20;
    const records: AigateInstance[] = [];
    const seen = new Set<string>();
    let previousTotal: number | undefined;
    let stable = true;
    for (let current = 1; current <= options.maxPages; current++) {
      const page = await this.pageInstances({ current, pageSize,
        ...(options.operationStatus === undefined ? {} : { operationStatus: options.operationStatus }) });
      if (previousTotal !== undefined && page.total !== previousTotal) stable = false;
      previousTotal = page.total;
      for (const instance of page.records) {
        if (seen.has(instance.id)) stable = false;
        else {
          seen.add(instance.id);
          if (instance.instanceName === name) records.push(instance);
        }
      }
      if (current * pageSize >= page.total || page.records.length < pageSize) {
        return { records, complete: stable && seen.size === page.total, pagesScanned: current };
      }
    }
    return { records, complete: false, pagesScanned: options.maxPages };
  }

  async releaseInstance(instanceId: string): Promise<void> {
    await this.request('release', instanceId);
  }

  async clearGpuIdleShutdown(instanceId: string): Promise<void> {
    await this.request('clearTimerStop', instanceId);
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

  private async request(action: 'get' | 'status' | 'open' | 'close' | 'setTimerStop' | 'clearTimerStop' | 'skuList' | 'start' | 'page' | 'release',
    instanceId?: string, query?: Record<string, string>, payload?: string): Promise<unknown> {
    const needsId = !['skuList', 'start', 'page'].includes(action);
    if (needsId && (typeof instanceId !== 'string' || !/^\d+$/.test(instanceId))) {
      throw new AigateError('INVALID_ARGUMENT', 'AIGate instance ID must be a decimal string');
    }
    const gpuIdleShutdown = action === 'setTimerStop' || action === 'clearTimerStop';
    if ((gpuIdleShutdown || action === 'release') && !isInt64(instanceId)) {
      throw new AigateError('INVALID_ARGUMENT', 'AIGate instance ID must be a canonical non-negative int64 decimal string');
    }
    const url = new URL('/api/openapi/instance/' + (action === 'clearTimerStop' ? 'setTimerStop' : action), this.#baseUrl);
    if (needsId && !gpuIdleShutdown) url.searchParams.set('instanceId', instanceId!);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const post = gpuIdleShutdown || action === 'start' || action === 'page';
    const bodyText = gpuIdleShutdown ? '{"instanceId":' + instanceId + (action === 'clearTimerStop'
      ? ',"stopType":"0"}' : ',"stopType":"2","utilizationRate":10,"leisureTime":30}') : payload;
    const mutation = action === 'start' || action === 'release' || action === 'clearTimerStop';
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
            method: post ? 'POST' : 'GET',
            headers: { Authorization: 'Bearer ' + this.#token, ...(post ? { 'Content-Type': 'application/json' } : {}) },
            ...(bodyText === undefined ? {} : { body: bodyText }),
            signal: controller.signal,
            redirect: 'error',
            cache: 'no-store'
          });
        } catch (error) {
          const notSent = failedBeforeSend(error);
          throw new AigateError('NETWORK_ERROR', notSent ? 'AIGate connection failed before request submission'
            : 'AIGate network failure; outcome unknown', undefined, false, undefined, notSent ? false : undefined);
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
          const msg = typeof body.msg === 'string' ? body.msg : '';
          const explicitlyUnavailable = msg.length <= 500 &&
            /(?:显卡|GPU|算力)(?:资源|库存)?(?:不足|已售罄|已售完|暂无库存)|(?:暂无|没有|无)可用(?:的)?(?:GPU|显卡|算力)|(?:GPU|显卡)(?:资源)?(?:暂不可用|暂时不可用)/i.test(msg);
          if ((action === 'open' || action === 'start') && (errCode !== undefined && this.#capacityErrorCodes.has(errCode) || explicitlyUnavailable)) {
            throw new AigateError('CAPACITY_UNAVAILABLE', 'AIGate capacity is unavailable', errCode);
          }
          // 只保留可行动的分类，不保存原始 msg；上层据此区分“充值能解决”和“稍后自动重试”。
          throw new AigateError('BUSINESS_REJECTED', 'AIGate explicitly rejected the request', errCode, false, rejectionReason(msg, action));
        }
        if (action === 'status' && typeof body.data !== 'string') return invalidResponse();
        if ((action === 'open' || action === 'close' || action === 'release') && body.data !== null && typeof body.data !== 'string') {
          return invalidResponse();
        }
        if (gpuIdleShutdown && body.data !== null && body.data !== true) return invalidResponse();
        return body.data;
      })()]);
    } catch (error) {
      if (mutation && error instanceof AigateError && error.requestSent !== false
        && !['BUSINESS_REJECTED', 'CAPACITY_UNAVAILABLE'].includes(error.code)) {
        throw new AigateError(error.code, error.message, error.errCode, true, error.reason);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
