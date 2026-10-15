import { afterEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { MioraClient } from './miora-client.js';
import { classifyMioraError } from './miora-retry.js';

const originalDispatcher = getGlobalDispatcher();
afterEach(() => setGlobalDispatcher(originalDispatcher));

describe('MioraClient credit errors', () => {
  it('keeps the same task polling through progress credit gates beyond the network retry count', async () => {
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    const progress = { path:'/api/ai/media-generate/progress', method:'POST', body:JSON.stringify({ videoTaskIds:['t1'] }) };
    origin.intercept(progress).reply(200, { code:10005, message:'Insufficient AI credits' }).times(5);
    origin.intercept(progress).reply(200, { data:{ tasks:{ t1:{ status:'completed', resultSignUrl:'https://cdn/t1.mp4' } } } });
    try {
      expect(await new MioraClient({ authToken:'token' }).waitForTask('t1', {
        timeoutMs:1_000, retryDelaysMs:[1, 1, 1]
      })).toMatchObject({ taskId:'t1', status:'succeeded' });
      expect(mock.pendingInterceptors()).toEqual([]);
    } finally { await mock.close(); }
  });

  it('keeps query deadline failure distinct from submit credits and real failed task verdicts', async () => {
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    origin.intercept({ path:'/api/ai/media-generate/progress', method:'POST' })
      .reply(200, { code:10005, message:'Insufficient AI credits' });
    origin.intercept({ path:'/api/ai/media-generate/video', method:'POST' })
      .reply(200, { code:10005, message:'Insufficient AI credits' });
    origin.intercept({ path:'/api/ai/media-generate/progress', method:'POST' })
      .reply(200, { data:{ tasks:{ t1:{ status:'failed', errorMessage:'Insufficient AI credits' } } } });
    const client = new MioraClient({ authToken:'token' });
    try {
      await expect(client.waitForTask('t1', { timeoutMs:1, retryDelaysMs:[5] }))
        .rejects.toMatchObject({ code:'PROVIDER_QUERY_BLOCKED', providerTerminal:false });
      const rejected = await client.generateVideo({ model:'minimax-h3', prompt:'isolated', durationSeconds:4,
        resolution:'768P', aspectRatio:'16:9' }).catch(error => error);
      expect(classifyMioraError(rejected)).toMatchObject({ kind:'insufficient_credits', retryable:false, providerTerminal:false });
      const terminal = await client.waitForTask('t1', { timeoutMs:1_000 }).catch(error => error);
      expect(classifyMioraError(terminal)).toMatchObject({ kind:'insufficient_credits', providerTerminal:true });
    } finally { await mock.close(); }
  });

  it.each([
    { status: 403, body: { code: 'FORBIDDEN', message: 'Access denied' } },
    { status: 429, body: { message: 'Too many requests' } },
    { status: 502, body: { message: 'Bad gateway' } },
    { status: 502, body: '<html>bad gateway</html>' },
    { status: 200, body: { data: { code: 'UNAVAILABLE', message: 'Quota unavailable' } } },
    { status: 200, body: { data: { total_amount: 'bad', used_amount: 0 } } },
    { status: 200, body: '<html>verification required</html>' }
  ])('preserves HTTP $status when credit reading fails', async ({ status, body }) => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock.get('https://miora.design').intercept({ path: '/api/ai/quota/credit', method: 'GET' }).reply(status, body);
    try {
      await expect(new MioraClient({ authToken: 'token' }).getCredits()).rejects.toMatchObject({
        name: 'MioraApiError', status, path: '/quota/credit'
      });
    } finally {
      await mock.close();
    }
  });
});

describe('MioraClient token renewal', () => {
  it('rechecks the paid-submit gate after token renewal before retrying a rejected request', async () => {
    const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    let submissions = 0; let checks = 0;
    origin.intercept({ path: '/api/ai/media-generate/video', method: 'POST' })
      .reply(() => { submissions++; return { statusCode: 401, data: 'expired' }; });
    origin.intercept({ path: '/api/auth/refresh-token', method: 'POST' })
      .reply(200, { access_token: 'new-access', refresh_token: 'new-refresh' });
    const client = new MioraClient({ authToken: 'old-access', refreshToken: 'old-refresh' });
    try {
      await expect(client.generateVideo({ model: 'minimax-h3', prompt: 'isolated', durationSeconds: 4,
        resolution: '768P', aspectRatio: '16:9' }, undefined, async () => {
        if (++checks > 1) throw new Error('Execution canceled during token renewal');
      })).rejects.toThrow('Execution canceled');
      expect(checks).toBe(2); expect(submissions).toBe(1);
    } finally { await mock.close(); }
  });
  it('persists the rotated pair before retrying a rejected request', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    const events: string[] = [];
    origin.intercept({ path: '/api/ai/quota/credit', method: 'GET' })
      .reply(401, 'expired');
    origin.intercept({ path: '/api/auth/refresh-token', method: 'POST' })
      .reply(200, { access_token: 'new-access', refresh_token: 'new-refresh' });
    origin.intercept({ path: '/api/ai/quota/credit', method: 'GET' })
      .reply(() => {
        events.push('retry');
        return { statusCode: 200, data: { data: { total_amount: 100, used_amount: 20 } } };
      });

    const client = new MioraClient({ authToken: 'old-access', refreshToken: 'old-refresh' },
      async (previous, renewed) => {
        expect(previous).toMatchObject({ authToken: 'old-access', refreshToken: 'old-refresh' });
        expect(renewed).toMatchObject({ authToken: 'new-access', refreshToken: 'new-refresh' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('saved');
      });
    try {
      expect((await client.getCredits()).totalCredits).toBe(80);
      expect(events).toEqual(['saved', 'retry']);
    } finally {
      await mock.close();
    }
  });

  it('keeps polling a task the progress map does not list yet', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    const progress = { path: '/api/ai/media-generate/progress', method: 'POST' };
    origin.intercept(progress).reply(200, { data: { tasks: {} } }).times(5);
    origin.intercept(progress).reply(200, { data: { tasks: { t1: { status: 'completed', resultSignUrl: 'https://cdn/t1.mp4' } } } });
    const client = new MioraClient({ authToken: 'token' });
    try {
      const task = await client.waitForTask('t1', { timeoutMs: 1_000, intervalMs: 1, retryDelaysMs: [1] });
      expect(task).toMatchObject({ status: 'succeeded', resultSignUrl: 'https://cdn/t1.mp4' });
    } finally {
      await mock.close();
    }
  });

  it('does not report a failed progress read as a missing task', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    origin.intercept({ path: '/api/ai/media-generate/progress', method: 'POST' })
      .reply(502, '<html>bad gateway</html>');
    const client = new MioraClient({ authToken: 'token' });
    try {
      await expect(client.getTask('t1')).rejects.toMatchObject({ name: 'MioraApiError', status: 502 });
    } finally {
      await mock.close();
    }
  });

  it('creates one account project and attaches it to submissions', async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const origin = mock.get('https://miora.design');
    const token = 'e.' + Buffer.from(JSON.stringify({ sub: 'workflow-test-account' })).toString('base64url') + '.s';
    origin.intercept({ path: '/api/ai/workflow/list?page=1&pageSize=20', method: 'GET' })
      .reply(200, { data: { list: [] } });
    origin.intercept({ path: '/api/ai/workflow/create', method: 'POST' })
      .reply(200, { data: 987 });
    const submitted: Array<Record<string, unknown>> = [];
    origin.intercept({ path: '/api/ai/media-generate/video', method: 'POST' })
      .reply((request) => {
        submitted.push(JSON.parse(String(request.body)) as Record<string, unknown>);
        return { statusCode: 200, data: { data: { taskId: 'job-123' } } };
      });
    const client = new MioraClient({ authToken: token });
    try {
      const id = await client.getOrCreateWorkflowId();
      expect(id).toBe('987');
      expect(await client.generateVideo({ model: 'minimax-h3', prompt: '测试', durationSeconds: 5,
        resolution: '768P', aspectRatio: '9:16', workflowId: id })).toBe('job-123');
      expect(submitted[0]?.workflowId).toBe('987');
    } finally {
      await mock.close();
    }
  });
});
