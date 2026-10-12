import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getGlobalDispatcher, setGlobalDispatcher, MockAgent } from 'undici';
import { CREDIT_API_PATH, mioraDispatcherFor, mioraRequest, useMioraProxy } from '../dist/adapters/miora-api.js';

test('online Miora gateway never falls back to direct when its proxy fails', async () => {
  const original = getGlobalDispatcher();
  const direct = new MockAgent();
  const proxy = new MockAgent();
  direct.disableNetConnect(); proxy.disableNetConnect();
  let directCalls = 0;
  const directDispatch = direct.dispatch.bind(direct);
  direct.dispatch = (...args) => { directCalls++; return directDispatch(...args); };
  setGlobalDispatcher(direct);
  try {
    assert.throws(() => useMioraProxy(undefined, '', undefined, true), /MIORA_PROXY_URL/);
    useMioraProxy('http://127.0.0.1:1', '', undefined, true);
    mioraDispatcherFor().dispatch = proxy.dispatch.bind(proxy);
    proxy.get('https://miora.design').intercept({ method: 'GET', path: `/api/ai${CREDIT_API_PATH}` }).reply(502, { message: 'isolated proxy failure' });
    await assert.rejects(mioraRequest('isolated-token', CREDIT_API_PATH));
    assert.equal(directCalls, 0, 'Proxy failure cannot send the authenticated read directly');
    proxy.assertNoPendingInterceptors();
    // Existing local usage keeps its configured fallback policy.
    useMioraProxy('http://127.0.0.1:1', '');
    mioraDispatcherFor().dispatch = proxy.dispatch.bind(proxy);
    proxy.get('https://miora.design').intercept({ method: 'GET', path: `/api/ai${CREDIT_API_PATH}` }).reply(502, { message: 'isolated proxy failure' });
    direct.get('https://miora.design').intercept({ method: 'GET', path: `/api/ai${CREDIT_API_PATH}` }).reply(200, { data: { total_amount: 100, used_amount: 0 } });
    const response = await mioraRequest('isolated-token', CREDIT_API_PATH);
    assert.equal(response.status, 200);
    assert.equal(directCalls, 1);
    proxy.assertNoPendingInterceptors(); direct.assertNoPendingInterceptors();
  } finally {
    useMioraProxy();
    setGlobalDispatcher(original);
    await direct.close(); await proxy.close();
  }
});
