#!/usr/bin/env node

/**
 * 加一个 Higgsfield 账号。
 *
 * 一次登录 = 一条 OAuth 凭据，直接写进账号文件，服务热重载后就能派任务。
 * 登录页开在**本机 Chrome 的临时资料目录**里（无痕：和日常那份 Chrome 隔开，
 * 关掉即清空），所以连着加好几个号不用来回退出登录。
 *
 * 走的是 Higgsfield 官方 MCP 的 OAuth（动态注册 + PKCE），不是网页端那套 Clerk
 * cookie —— 后者在 `/jobs/*` 上被 DataDome 挡着，试用号还会被平台直接顶回来。
 *
 * 用法：
 *   npm run higgsfield:login
 *   npm run higgsfield:login -- --email=someone@outlook.com   # 预填账号
 *   npm run higgsfield:login -- --browser=msedge --direct --print
 *
 *   --email=<地址>   预填到登录页（微软/谷歌都认）。
 *   --browser=<名字> chrome（默认）/ msedge / chromium。
 *   --exe=<路径>     直接指定浏览器可执行文件。
 *   --port=<端口>    OAuth 回调端口，默认 8931。
 *   --proxy=<url>    出口代理；--direct 不走代理。
 *   --timeout=<分钟> 等人工登录的上限，默认 15。
 *   --print          只打印，不写账号文件。
 */

const { config } = await import('../src/config.ts');
const {
  authorizeUrl,
  createPkcePair,
  describeMcpToken,
  exchangeAuthorizationCode,
  randomState,
  registerOAuthClient,
  useHiggsfieldMcpProxy,
  HiggsfieldMcpSession
} = await import('../src/adapters/higgsfield-mcp.ts');
const { readCredits } = await import('../src/adapters/higgsfield-mcp.ts');
const {
  formatHiggsfieldAccount,
  higgsfieldAccountId,
  parseHiggsfieldAccounts
} = await import('../src/jobs/higgsfield-accounts.ts');
const { chromium } = await import('playwright');
const { createServer } = await import('node:http');
const { readFile, writeFile } = await import('node:fs/promises');
const { existsSync } = await import('node:fs');

const BROWSER_PATHS = {
  chrome: [
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`
  ],
  msedge: [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
  ]
};

function parseArgs(argv) {
  const flags = new Map();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`不认识的参数：${arg}`);
    flags.set(match[1], match[2] ?? '');
  }
  return flags;
}

function resolveProxy(flags) {
  if (flags.has('direct')) return undefined;
  return flags.get('proxy')
    || config.higgsfieldProxyUrl
    || process.env.HAILUO_LOCAL_PROXY_URL?.trim()
    || 'http://127.0.0.1:7897';
}

function playwrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    bypass: 'localhost,127.0.0.1'
  };
}

function resolveBrowser(flags) {
  const exe = flags.get('exe');
  if (exe) return { executablePath: exe, label: exe };
  const name = (flags.get('browser') || 'chrome').toLowerCase();
  if (name === 'chromium') return { channel: 'chromium', label: 'playwright chromium' };
  if (!BROWSER_PATHS[name]) throw new Error(`--browser 只认 chrome / msedge / chromium（给的是 ${name}）`);
  const found = BROWSER_PATHS[name].find((candidate) => existsSync(candidate));
  return { channel: name, ...(found ? { executablePath: found } : {}), label: found ?? name };
}

/** 等一次 OAuth 回调。 */
function waitForCallback(port, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') return void response.writeHead(404).end('not found');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<meta charset="utf-8"><h2>授权完成，这一页可以关了。</h2>');
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
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`等授权超时（${Math.round(timeoutMs / 60_000)} 分钟）`));
    }, timeoutMs);
    timer.unref();
  });
}

/**
 * 写账号文件：同一个账号就地换掉，新账号追加。每条上面带一行注释，续期时一起更新。
 */
function upsertAccount(contents, account) {
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  const entry = formatHiggsfieldAccount(account);
  const marker = `# ${new Date().toISOString().slice(0, 10)}${account.email ? ` ${account.email}` : ''}`;
  const lines = contents ? contents.split(/\r?\n/) : [];
  while (lines.length && lines.at(-1) === '') lines.pop();

  const existing = parseHiggsfieldAccounts(contents).accounts.find((line) => line.sessionId === account.id);
  if (existing) {
    const index = existing.line - 1;
    lines[index] = entry;
    if (index > 0 && lines[index - 1].startsWith('# ')) lines[index - 1] = marker;
    else lines.splice(index, 0, marker);
    return { contents: `${lines.join(eol)}${eol}`, replaced: true };
  }
  if (lines.length) lines.push('');
  lines.push(marker, entry);
  return { contents: `${lines.join(eol)}${eol}`, replaced: false };
}

const FILE_HEADER = [
  '# Higgsfield 账号：一行一个 JSON，由 `npm run higgsfield:login` 写入。',
  '# 凭据是官方 MCP 的 OAuth refresh token；服务自己换短 token，不要手改。'
].join('\n');

const flags = parseArgs(process.argv.slice(2));
const port = Number(flags.get('port') || 8931);
const redirectUri = `http://127.0.0.1:${port}/callback`;
const timeoutMs = Math.max(1, Number(flags.get('timeout') || 15)) * 60_000;
const proxyUrl = resolveProxy(flags);
const browser = resolveBrowser(flags);
useHiggsfieldMcpProxy(proxyUrl);

console.log(`浏览器：${browser.label}（无痕：临时资料目录，关掉即清空）`);
console.log(`出口：${proxyUrl ?? '直连'}`);

const { clientId } = await registerOAuthClient(redirectUri);
const { verifier, challenge } = createPkcePair();
const state = randomState();
const url = authorizeUrl({
  clientId,
  redirectUri,
  challenge,
  state,
  loginHint: flags.get('email') || undefined,
  // 每次都要求重新认证，免得静默复用上一个号——加号就是为了加**别的**号。
  forceLogin: true
});

const pending = waitForCallback(port, state, timeoutMs);
const instance = await chromium.launch({
  headless: false,
  ...(browser.channel ? { channel: browser.channel } : {}),
  ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
  proxy: playwrightProxy(proxyUrl),
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
});
const context = await instance.newContext({ viewport: null });
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error) => {
  console.warn(`授权页没打开（${error.message}）；也可以自己访问：\n${url}`);
});

console.log('');
console.log('在打开的窗口里用微软邮箱密码登录，然后点「同意授权」。');
console.log(`最多等 ${timeoutMs / 60_000} 分钟。`);
console.log('');

let code;
try {
  code = await pending;
} finally {
  await instance.close().catch(() => {});
}

const tokens = await exchangeAuthorizationCode({ clientId, code, redirectUri, verifier });
// 身份在 id_token 里；access token 只是个凭证，不带 email 和 user id。
const claims = describeMcpToken(tokens.idToken ?? tokens.accessToken ?? '');
const id = higgsfieldAccountId({ userId: claims.userId, email: claims.email, clientId });

// 立刻用一次，确认这条凭据真能干活。
const session = new HiggsfieldMcpSession(tokens);
const balance = readCredits(await session.callTool('balance'));

console.log(`账号：${claims.email ?? claims.userId ?? id}`);
console.log(`余额：${balance.credits} 积分${balance.plan ? `（${balance.plan}）` : ''}`);
console.log(`凭据：refresh_token ${tokens.refreshToken ? '有' : '无'}，access_token 有效期到 ${
  tokens.expiresAt ? new Date(tokens.expiresAt).toLocaleString() : '未说明'}`);

if (flags.has('print')) {
  console.log('');
  console.log(formatHiggsfieldAccount({ id, email: claims.email, tokens }));
  console.log('（--print：没有写文件）');
} else {
  const file = config.higgsfieldAccountFile;
  const current = await readFile(file, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return `${FILE_HEADER}\n`;
  });
  const { contents, replaced } = upsertAccount(current, { id, email: claims.email, tokens });
  await writeFile(file, contents, 'utf8');
  console.log('');
  console.log(`${replaced ? '已更新' : '已加入'} ${id} → ${file}`);
  console.log('服务运行中会自己重读这个文件，不用重启。再加一个号就再跑一次本命令。');
}
