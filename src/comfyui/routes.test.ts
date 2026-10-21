import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertVideoGatewayRequest } from '../system-channels/video-gateway.js';
import type { SystemRuntime } from '../system/index.js';
import { assertAdmin, SystemError, type AuditInput, type SystemPrincipal } from '../system/types.js';
import { registerComfyAdminRoutes } from './routes.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore, type ComfyInstanceRow } from './store.js';

const key = 'isolated-comfy-gateway-key-at-least-32-characters';
const adminHeaders = { 'x-test-role': 'superadmin' };
const fixtures: Array<{ app: FastifyInstance; db: Database.Database; external: ReturnType<typeof vi.fn>[] }> = [];

function fixture() {
  const db = new Database(':memory:');
  const app = Fastify();
  const store = new ComfyStore(db);
  db.exec('CREATE TABLE test_audit (actor_id TEXT, action TEXT, target_type TEXT, target_id TEXT)');
  const auditRows = () => db.prepare('SELECT * FROM test_audit ORDER BY rowid').all();
  const audit = vi.fn((input: AuditInput) => {
    expect(db.inTransaction).toBe(true);
    db.prepare('INSERT INTO test_audit VALUES(?,?,?,?)').run(input.actorId, input.action, input.targetType, input.targetId);
  });
  const requireAdmin = vi.fn<SystemRuntime['requireAdmin']>(async (request, permission = 'read') => {
    const role = request.headers['x-test-role'];
    if (role === undefined) throw new SystemError(401, 'UNAUTHENTICATED', 'Authentication required');
    const principal = { id: 'test-admin', role: role === 'member' ? null : role } as SystemPrincipal;
    assertAdmin(principal, permission);
    return principal;
  });
  const runtime = { db, requireAdmin, store: { audit } } as unknown as SystemRuntime;
  type Client = ReturnType<ComfyServiceOptions['client']>;
  const client = {
    health: vi.fn<Client['health']>(), queue: vi.fn<Client['queue']>(), upload: vi.fn<Client['upload']>(),
    submit: vi.fn<Client['submit']>(), history: vi.fn<Client['history']>(),
    findAttempt: vi.fn<Client['findAttempt']>(), download: vi.fn<Client['download']>(),
  };
  const platform = {
    getInstanceStatus: vi.fn<ComfyServiceOptions['platform']['getInstanceStatus']>(),
    openInstance: vi.fn<ComfyServiceOptions['platform']['openInstance']>(),
    closeInstance: vi.fn<ComfyServiceOptions['platform']['closeInstance']>(),
  };
  const results = { save: vi.fn<ComfyServiceOptions['results']['save']>(), read: vi.fn<ComfyServiceOptions['results']['read']>() };
  const service = new ComfyService({
    store, owner: 'owner', platform, client: () => client, results,
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    configuration: {
      autoOpen: false, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
      instances: [{ id: '1', baseUrl: 'https://private-comfy.invalid/?token=URL_SECRET', headers: { Authorization: 'Bearer TOKEN_SECRET' }, workflowIds: ['example'] }],
      workflows: [{ id: 'example', version: '1', graph: { '1': { class_type: 'PRIVATE_GRAPH_NODE', inputs: { text: 'GRAPH_SECRET' } } },
        bindings: { text: { nodeId: '1', input: 'text', kind: 'value', required: true } }, outputNodeIds: ['1'] }],
    },
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    reply.code(error.statusCode ?? 500).send({ code: error.code ?? 'REQUEST_FAILED' });
  });
  registerComfyAdminRoutes(app, runtime, service);
  fixtures.push({ app, db, external: [...Object.values(platform), ...Object.values(client), ...Object.values(results)] });
  const submit = (requestKey: string) => service.submit({ adapterId: 'comfyui-v1', requestKey, workflowId: 'example', values: { text: 'PRIVATE_JOB_INPUT' }, media: {} }).job;
  const operate = (action: string, id = '1', headers: Record<string, string> = adminHeaders) => app.inject({ method: 'POST', url: `/api/admin/comfyui/instances/${id}/${action}`, headers });
  return { app, db, store, service, audit, auditRows, requireAdmin, submit, operate };
}

afterEach(async () => {
  for (const { app, db, external } of fixtures.splice(0)) {
    try {
      await app.close();
      for (const operation of external) expect(operation).not.toHaveBeenCalled();
    } finally { db.close(); }
  }
  vi.restoreAllMocks();
});

describe('registerComfyAdminRoutes', () => {
  it('returns only the registered public projection, never URLs, tokens, graph or frozen job input', async () => {
    const { app, store, submit, auditRows, requireAdmin } = fixture();
    store.registerInstances(['99']);
    store.updateInstance('1', { state: 'ready' });
    const job = submit('pending-result');
    store.claim('1', ['example']);
    store.updateJob(job.id, { stage: 'collecting', result_pending: 1 });
    submit('queued');
    const response = await app.inject({ method: 'GET', url: '/api/admin/comfyui', headers: { 'x-test-role': 'readonly' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      autoOpen: false, queued: 1,
      elastic: { enabled: false, lastError: null }, resources: [],
      metrics: expect.objectContaining({ queued: 1, eligibleQueued: 1,
        cost: expect.objectContaining({ isEstimate: true, includesHistoricalBilling: false, unknownCostInstances: 1 }) }),
      instances: [{ id: '1', state: 'busy', draining: false, jobId: job.id, errorCode: null, pendingResults: 1, nextActionAt: null,
        idleSince: null, stoppedAt: null }],
      workflows: [{ id: 'example', version: '1', bindings: [{ name: 'text', kind: 'value', required: true }] }],
    });
    for (const secret of ['https://', 'private-comfy', 'URL_SECRET', 'TOKEN_SECRET', 'Authorization', 'PRIVATE_GRAPH_NODE', 'GRAPH_SECRET', 'PRIVATE_JOB_INPUT', 'baseUrl', 'graph']) {
      expect(response.body).not.toContain(secret);
    }
    expect(requireAdmin).toHaveBeenCalledOnce();
    expect(auditRows()).toEqual([]);
  });

  it.each([undefined, 'member'])('requires administrator access to read the projection (%s)', async role => {
    const { app, auditRows } = fixture();
    const response = await app.inject({ method: 'GET', url: '/api/admin/comfyui', headers: role ? { 'x-test-role': role } : {} });
    expect(response.statusCode).toBe(role ? 403 : 401);
    expect(auditRows()).toEqual([]);
  });

  it.each(['open', 'close', 'drain'])('authorizes and commits %s state with its audit in the same transaction', async action => {
    const { operate, store, service, auditRows, requireAdmin, db } = fixture();
    store.updateInstance('1', { state: 'ready' });
    const control = service.control.bind(service);
    vi.spyOn(service, 'control').mockImplementation((id, selected) => {
      expect(db.inTransaction).toBe(true);
      expect(auditRows()).toHaveLength(1);
      control(id, selected);
    });
    const response = await operate(action);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ instanceId: '1', action, accepted: true });
    expect(requireAdmin).toHaveBeenCalledWith(expect.anything(), 'authorize');
    expect(auditRows()).toEqual([{ actor_id: 'test-admin', action: `comfyui.instance.${action}`, target_type: 'comfyInstance', target_id: '1' }]);
    expect(store.instance('1')).toMatchObject(action === 'drain' ? { state: 'ready', draining: 1 } : { state: action === 'open' ? 'starting' : 'closing', draining: action === 'close' ? 1 : 0, action_sent: 0 });
    expect(db.inTransaction).toBe(false);
  });

  it.each(['open', 'close', 'drain'])('rejects %s without authorize permission before auditing or changing state', async action => {
    const { operate, store, auditRows, requireAdmin, service } = fixture();
    const control = vi.spyOn(service, 'control');
    const before = store.instance('1');
    for (const role of [undefined, 'member', 'readonly', 'operator']) {
      const response = await operate(action, '1', role ? { 'x-test-role': role } : {});
      expect(response.statusCode).toBe(role ? 403 : 401);
    }
    expect(requireAdmin.mock.calls.every(([, permission]) => permission === 'authorize')).toBe(true);
    expect(control).not.toHaveBeenCalled();
    expect(store.instance('1')).toEqual(before);
    expect(auditRows()).toEqual([]);
  });

  it('rolls back both state and audit if control fails after mutation', async () => {
    const { operate, store, service, auditRows } = fixture();
    const before = store.instance('1');
    const control = service.control.bind(service);
    vi.spyOn(service, 'control').mockImplementation((id, action) => { control(id, action); throw new Error('Failure after state update'); });
    expect((await operate('open')).statusCode).toBe(500);
    expect(store.instance('1')).toEqual(before);
    expect(auditRows()).toEqual([]);
  });

  it('rolls back an inserted audit and never changes state if auditing fails', async () => {
    const { operate, store, service, audit, auditRows } = fixture();
    const before = store.instance('1');
    const persist = audit.getMockImplementation()!;
    audit.mockImplementationOnce(input => { persist(input); throw new Error('Audit failure'); });
    const control = vi.spyOn(service, 'control');
    expect((await operate('close')).statusCode).toBe(500);
    expect(control).not.toHaveBeenCalled();
    expect(store.instance('1')).toEqual(before);
    expect(auditRows()).toEqual([]);
  });

  it.each(['99', '999'])('rejects closing an unknown or unconfigured instance %s and rolls back audit', async id => {
    const { operate, store, auditRows } = fixture();
    store.registerInstances(['99']);
    const before = store.instances();
    const response = await operate('close', id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'COMFY_INSTANCE_UNKNOWN' });
    expect(store.instances()).toEqual(before);
    expect(auditRows()).toEqual([]);
  });

  it.each<Partial<ComfyInstanceRow>>([{ state: 'starting' }, { state: 'closing' }, { state: 'busy', job_id: 'job_gateway_comfy_active' }])('rejects closing busy instance %j without persisting audit', async patch => {
    const { operate, store, auditRows } = fixture();
    store.updateInstance('1', patch);
    const before = store.instance('1');
    const response = await operate('close');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'COMFY_INSTANCE_BUSY' });
    expect(store.instance('1')).toEqual(before);
    expect(auditRows()).toEqual([]);
  });

  it('rejects close with uncollected results even after the active slot is clear', async () => {
    const { operate, store, submit, auditRows } = fixture();
    store.updateInstance('1', { state: 'ready' });
    const job = submit('uncollected');
    store.claim('1', ['example']);
    store.updateJob(job.id, { stage: 'collecting', result_pending: 1 });
    store.releaseSlot(job.id);
    expect(store.instance('1')).toMatchObject({ state: 'ready', job_id: null });
    const response = await operate('close');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'COMFY_INSTANCE_BUSY' });
    expect(store.instance('1')).toMatchObject({ state: 'ready', job_id: null });
    expect(store.pendingResults('1')).toHaveLength(1);
    expect(auditRows()).toEqual([]);
  });

  it.each([['restart', '1'], ['OPEN', '1'], ['close', 'abc'], ['close', '1'.repeat(31)]])('returns Zod 400 for invalid action/id %s/%s before audit', async (action, id) => {
    const { operate, auditRows, service, requireAdmin } = fixture();
    const control = vi.spyOn(service, 'control');
    const response = await operate(action, id);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_INPUT' });
    expect(requireAdmin).toHaveBeenCalledWith(expect.anything(), 'authorize');
    expect(control).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });
});

const resourceActions = [
  { action: 'inspect', auditAction: 'comfyui.resource.inspect' },
  { action: 'stop-unregistered', auditAction: 'comfyui.resource.stopUnregistered' },
] as const;

function resourceFixture(resourceKey = 'resource-1') {
  const context = fixture();
  context.audit.mockImplementation(input => {
    context.db.prepare('INSERT INTO test_audit VALUES(?,?,?,?)').run(input.actorId, input.action, input.targetType, input.targetId);
  });
  context.store.saveResource({ key: resourceKey, name: 'private-worker', state: 'blocked', instance_id: '99', configuration: null,
    template_id: 'private-template', hourly_cost: 1, storage_hourly_cost: 0.1, created_at: 1_000, updated_at: 1_000, error_code: null });
  const operations = {
    inspect: vi.spyOn(context.service, 'inspectResource').mockResolvedValue(undefined),
    'stop-unregistered': vi.spyOn(context.service, 'stopUnregisteredResource').mockResolvedValue(undefined),
  };
  const request = (action: string, payload?: unknown, selectedKey = resourceKey, headers: Record<string, string> = adminHeaders) => context.app.inject({
    method: 'POST', url: '/api/admin/comfyui/resources/' + encodeURIComponent(selectedKey) + '/' + action,
    headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { ...context, operations, request, resourceKey };
}

describe.each(resourceActions)('ComfyUI resource administration: $action', ({ action, auditAction }) => {
  const confirmation = action === 'stop-unregistered' ? { confirmNoExternalWork: true } : undefined;

  it.each(['resource-1', 'a'.repeat(100)])('audits before calling the service with exactly the resource key %s', async resourceKey => {
    const context = resourceFixture(resourceKey);
    const expectedAudit = { actor_id: 'test-admin', action: auditAction, target_type: 'comfyResource', target_id: resourceKey };
    context.operations[action].mockImplementation(async selectedKey => {
      expect(selectedKey).toBe(resourceKey);
      expect(context.db.inTransaction).toBe(false);
      expect(context.auditRows()).toEqual([expectedAudit]);
    });
    const response = await context.request(action, confirmation);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ resourceKey, accepted: true });
    expect(context.requireAdmin).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'authorize');
    expect(context.audit).toHaveBeenCalledExactlyOnceWith({ actorId: 'test-admin', action: auditAction, targetType: 'comfyResource', targetId: resourceKey });
    expect(context.auditRows()).toEqual([expectedAudit]);
    expect(context.operations[action]).toHaveBeenCalledExactlyOnceWith(resourceKey);
    expect(context.operations[action === 'inspect' ? 'stop-unregistered' : 'inspect']).not.toHaveBeenCalled();
  });

  it.each([
    { role: undefined, status: 401, code: 'UNAUTHENTICATED' },
    { role: 'member', status: 403, code: 'ADMIN_REQUIRED' },
    { role: 'readonly', status: 403, code: 'SUPERADMIN_REQUIRED' },
    { role: 'operator', status: 403, code: 'SUPERADMIN_REQUIRED' },
  ])('rejects role=$role without auditing or calling either resource operation', async ({ role, status, code }) => {
    const context = resourceFixture();
    const before = context.store.resources();
    const response = await context.request(action, confirmation, context.resourceKey, role ? { 'x-test-role': role } : {});
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
    expect(context.requireAdmin).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'authorize');
    expect(context.audit).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations.inspect).not.toHaveBeenCalled();
    expect(context.operations['stop-unregistered']).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual(before);
  });

  it('checks authorization before validating input or revealing whether the resource exists', async () => {
    const context = resourceFixture();
    const lookup = vi.spyOn(context.store, 'resource');
    const response = await context.request(action, { confirmNoExternalWork: false }, 'invalid.key', {});
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(lookup).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations[action]).not.toHaveBeenCalled();
  });

  it.each(['invalid.key', 'bad/key', 'bad key', '资源'])('rejects invalid resource key %s before lookup or audit', async resourceKey => {
    const context = resourceFixture();
    const lookup = vi.spyOn(context.store, 'resource');
    const response = await context.request(action, confirmation, resourceKey);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_INPUT' });
    expect(lookup).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations[action]).not.toHaveBeenCalled();
  });

  it('rejects an overlong resource key at the router boundary before authorization or audit', async () => {
    const context = resourceFixture();
    const lookup = vi.spyOn(context.store, 'resource');
    const response = await context.request(action, confirmation, 'a'.repeat(101));
    expect(response.statusCode).toBe(414);
    expect(context.requireAdmin).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations[action]).not.toHaveBeenCalled();
  });

  it('returns 404 for a resource outside the pool without auditing or invoking the service', async () => {
    const context = resourceFixture();
    const response = await context.request(action, confirmation, 'missing-resource');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'COMFY_RESOURCE_UNKNOWN' });
    expect(context.audit).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations[action]).not.toHaveBeenCalled();
  });

  it('does not invoke the service if its audit cannot be persisted', async () => {
    const context = resourceFixture();
    const before = context.store.resources();
    context.audit.mockImplementationOnce(() => { throw new Error('private audit failure'); });
    const response = await context.request(action, confirmation);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'REQUEST_FAILED' });
    expect(response.body).not.toContain('private audit failure');
    expect(context.audit).toHaveBeenCalledTimes(1);
    expect(context.auditRows()).toEqual([]);
    expect(context.operations[action]).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual(before);
  });

  it.each([
    { status: 404, code: 'COMFY_RESOURCE_UNKNOWN' },
    { status: 409, code: 'COMFY_WORKER_BUSY' },
    { status: 409, code: action === 'inspect' ? 'COMFY_CREATION_UNCONFIRMED' : 'COMFY_RESOURCE_STOP_UNSAFE' },
    { status: 503, code: 'COMFY_RESOURCE_INSPECTION_UNAVAILABLE' },
  ])('preserves the attempted-operation audit when the service rejects with $status/$code', async ({ status, code }) => {
    const context = resourceFixture();
    context.operations[action].mockRejectedValueOnce(new SystemError(status, code, 'private provider detail TOKEN_SECRET'));
    const response = await context.request(action, confirmation);
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
    expect(response.body).not.toContain('TOKEN_SECRET');
    expect(context.operations[action]).toHaveBeenCalledExactlyOnceWith(context.resourceKey);
    expect(context.auditRows()).toEqual([{ actor_id: 'test-admin', action: auditAction, target_type: 'comfyResource', target_id: context.resourceKey }]);
  });

  it('returns a generic 500 without exposing unexpected service errors, retaining its audit', async () => {
    const context = resourceFixture();
    context.operations[action].mockRejectedValueOnce(new Error('https://private-provider.invalid?token=TOKEN_SECRET'));
    const response = await context.request(action, confirmation);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'REQUEST_FAILED' });
    expect(response.body).not.toContain('TOKEN_SECRET');
    expect(context.operations[action]).toHaveBeenCalledExactlyOnceWith(context.resourceKey);
    expect(context.auditRows()).toHaveLength(1);
  });
});

describe('ComfyUI stop-unregistered confirmation', () => {
  it.each([
    undefined, null, {}, true, [],
    { confirmNoExternalWork: false }, { confirmNoExternalWork: 'true' }, { confirmNoExternalWork: 1 },
    { confirmNoExternalWork: null }, { confirmNoExternalWork: true, force: true },
  ])('requires an explicit literal true and rejects invalid payload %j before lookup, audit or service call', async payload => {
    const context = resourceFixture();
    const lookup = vi.spyOn(context.store, 'resource');
    const response = await context.request('stop-unregistered', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_INPUT' });
    expect(context.requireAdmin).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'authorize');
    expect(lookup).not.toHaveBeenCalled();
    expect(context.audit).not.toHaveBeenCalled();
    expect(context.auditRows()).toEqual([]);
    expect(context.operations['stop-unregistered']).not.toHaveBeenCalled();
  });

  it('does not accept a query-string confirmation in place of the required JSON body', async () => {
    const context = resourceFixture();
    const response = await context.app.inject({ method: 'POST',
      url: '/api/admin/comfyui/resources/' + context.resourceKey + '/stop-unregistered?confirmNoExternalWork=true', headers: adminHeaders });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_INPUT' });
    expect(context.auditRows()).toEqual([]);
    expect(context.operations['stop-unregistered']).not.toHaveBeenCalled();
  });
});

function gatewayRequest(method: string, url: string, supplied: unknown = key): FastifyRequest {
  return { method, url, headers: { 'x-api-key': supplied } } as unknown as FastifyRequest;
}

const comfyActions = [['GET', 'result'], ['POST', 'cancel'], ['POST', 'reconcile']] as const;

describe('ComfyUI video gateway action allowlist', () => {
  it.each(comfyActions)('allows only the named Comfy job action %s %s with a valid key', (method, action) => {
    for (const suffix of ['example-1', 'a'.repeat(170)]) {
      const url = `/v1/jobs/job_gateway_comfy_${suffix}/${action}`;
      expect(() => assertVideoGatewayRequest(gatewayRequest(method, url), true, key)).not.toThrow();
      expect(() => assertVideoGatewayRequest(gatewayRequest(method, `${url}?download=1`), true, key)).not.toThrow();
    }
  });

  it.each(comfyActions)('rejects missing, wrong or repeated API keys for %s %s', (method, action) => {
    for (const supplied of [undefined, '', 'wrong-key', [key], `${key}x`]) {
      const request = gatewayRequest(method, `/v1/jobs/job_gateway_comfy_example/${action}`);
      request.headers['x-api-key'] = supplied as string | string[] | undefined;
      expect(() => assertVideoGatewayRequest(request, true, key)).toThrow(expect.objectContaining({ statusCode: 401, code: 'VIDEO_GATEWAY_UNAUTHORIZED' }));
    }
  });

  it.each(comfyActions)('does not expose %s %s when the gateway is disabled or unconfigured', (method, action) => {
    const request = gatewayRequest(method, `/v1/jobs/job_gateway_comfy_example/${action}`);
    expect(() => assertVideoGatewayRequest(request, false, key)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() => assertVideoGatewayRequest(request, true)).toThrow(expect.objectContaining({ statusCode: 500, code: 'VIDEO_GATEWAY_CONFIGURATION_INVALID' }));
  });

  it.each(comfyActions)('rejects %s %s for ordinary jobs, incomplete names and noncanonical paths', (method, action) => {
    for (const id of ['ordinary-job', 'job_gateway_ordinary', 'job_system_private', 'job_gateway_comfy_', `job_gateway_comfy_${'a'.repeat(171)}`, '%6aob_gateway_comfy_example', 'job_gateway_comfy_example/extra']) {
      expect(() => assertVideoGatewayRequest(gatewayRequest(method, `/v1/jobs/${id}/${action}`), true, key)).toThrow(expect.objectContaining({ statusCode: 404, code: 'LEGACY_API_DISABLED' }));
    }
    for (const url of [`/v1/jobs/job_gateway_comfy_example/${action}/`, `/v1/jobs//job_gateway_comfy_example/${action}`, `/v1/jobs/job_gateway_comfy_example/${action}/extra`]) {
      expect(() => assertVideoGatewayRequest(gatewayRequest(method, url), true, key)).toThrow(expect.objectContaining({ statusCode: 404 }));
    }
  });

  it.each(comfyActions)('rejects every other HTTP method for the %s %s action', (allowed, action) => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter(candidate => candidate !== allowed)) {
      expect(() => assertVideoGatewayRequest(gatewayRequest(method, `/v1/jobs/job_gateway_comfy_example/${action}`), true, key)).toThrow(expect.objectContaining({ statusCode: 404 }));
    }
  });
});
