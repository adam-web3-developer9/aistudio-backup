#!/usr/bin/env node

/**
 * 拿 Higgsfield 的 MCP 访问令牌。
 *
 * 为什么要这条：试用号在网关上提交会被 403 `only_mcp_usage_on_trial_is_available`
 * 顶回来——平台明说了，这类账号只能走 MCP。而 MCP 那条链路顺带绕开了 `/jobs/*`
 * 上的 DataDome：它是官方给程序用的接口，不是给浏览器用的。
 *
 * 流程和官方插件一样：动态注册一个公开客户端 → PKCE 授权 → 换 token。
 * 唯一的区别是回调地址：插件用 chrome-extension 的 chromiumapp.org，我们用本机回环。
 * 授权页开在常驻浏览器里（npm run higgsfield:browser），那儿已经是登录态，点一下同意即可。
 *
 * 用法：
 *   npm run higgsfield:mcp-login                 # 授权页开在常驻浏览器（CDP 9222）
 *   npm run higgsfield:mcp-login -- --port=8931  # 换回调端口
 *   npm run higgsfield:mcp-login -- --no-cdp     # 常驻浏览器没开时，打印链接自己开
 *
 * token 存在 higgsfield-mcp-tokens.json（已 gitignore）。带 refresh_token，
 * 过期由调用方自己续。
 */

const { createHash, randomBytes } = await import('node:crypto');
const { createServer } = await import('node:http');
const { writeFile } = await import('node:fs/promises');
const path = (await import('node:path')).default;

const MCP_ORIGIN = 'https://mcp.higgsfield.ai';
const REGISTER = `${MCP_ORIGIN}/oauth2/register`;
const AUTHORIZE = `${MCP_ORIGIN}/oauth2/authorize`;
const TOKEN = `${MCP_ORIGIN}/oauth2/token`;
const SCOPE = 'openid email offline_access';
const TOKEN_FILE = path.resolve('./higgsfield-mcp-tokens.json');

function parseArgs(argv) {
  const flags = new Map();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`不认识的参数：${arg}`);
    flags.set(match[1], match[2] ?? '');
  }
  return flags;
}

const base64url = (buffer) => buffer.toString('base64url');
const randomString = (bytes) => base64url(randomBytes(bytes));

/** 等一次 OAuth 回调，拿到 code 就把浏览器那页收尾。 */
function waitForCallback(port, expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<meta charset="utf-8"><h2>授权完成，可以关掉这一页了。</h2>');
      server.close();

      const error = url.searchParams.get('error');
      if (error) return reject(new Error(url.searchParams.get('error_description') || error));
      if (url.searchParams.get('state') !== expectedState) return reject(new Error('OAuth state 不匹配'));
      const code = url.searchParams.get('code');
      if (!code) return reject(new Error('回调里没有 authorization code'));
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
    setTimeout(() => {
      server.close();
      reject(new Error('等授权超时（5 分钟）'));
    }, 5 * 60_000).unref();
  });
}

const flags = parseArgs(process.argv.slice(2));
const port = Number(flags.get('port') || 8931);
const redirectUri = `http://127.0.0.1:${port}/callback`;

// 1) 动态注册一个公开客户端（没有 client_secret，靠 PKCE）。
const registration = await fetch(REGISTER, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'hailuo gateway',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  })
});
if (!registration.ok) {
  throw new Error(`注册客户端失败 ${registration.status}: ${(await registration.text()).slice(0, 300)}`);
}
const client = await registration.json();
console.log('client_id:', client.client_id);

// 2) 授权码 + PKCE。
const verifier = randomString(48);
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = randomString(24);
const authorizeUrl = new URL(AUTHORIZE);
for (const [key, value] of Object.entries({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: redirectUri,
  scope: SCOPE,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state
})) authorizeUrl.searchParams.set(key, value);

const pending = waitForCallback(port, state);

if (flags.has('no-cdp')) {
  console.log('\n在浏览器里打开这个地址完成授权：\n', authorizeUrl.toString(), '\n');
} else {
  const { chromium } = await import('playwright');
  const endpoint = process.env.HIGGSFIELD_BROWSER_CDP ?? 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(authorizeUrl.toString(), { waitUntil: 'domcontentloaded' });
  console.log('\n授权页已经开在常驻浏览器里，点一下「同意」。\n');
  // 只断开 CDP，不关浏览器。
  await browser.close();
}

const code = await pending;

// 3) 换 token。
const exchange = await fetch(TOKEN, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier
  })
});
if (!exchange.ok) throw new Error(`换 token 失败 ${exchange.status}: ${(await exchange.text()).slice(0, 300)}`);
const tokens = await exchange.json();
if (!tokens.access_token) throw new Error('token 响应里没有 access_token');

const record = {
  savedAt: new Date().toISOString(),
  client_id: client.client_id,
  redirect_uri: redirectUri,
  ...tokens
};
await writeFile(TOKEN_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

const claims = (() => {
  try {
    return JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
})();
console.log('拿到 access_token，写入', TOKEN_FILE);
console.log('有效期:', tokens.expires_in ? `${tokens.expires_in} 秒` : '未说明',
  '| refresh_token:', tokens.refresh_token ? '有' : '无');
if (claims?.sub || claims?.email) console.log('身份:', claims.email ?? claims.sub);
