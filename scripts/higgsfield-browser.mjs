#!/usr/bin/env node

/**
 * 一个**常驻**的 Higgsfield 浏览器会话。开着别关。
 *
 * 为什么要常驻：higgsfield.ai 的 `/jobs/*`（提交、status-batch）被 DataDome 盯着，
 * 每开一个新浏览器就是一个全新会话，DataDome 一律按「首次遭遇」处理、要求过验证码。
 * 所以这个会话只开一次：人工登录 + 过一次验证码之后，它就一直活着，后面所有脚本
 * （以及将来的服务）都通过 CDP 连上来复用它，用完**不关**。
 *
 * 用法：
 *   npm run higgsfield:browser              # 开着，Ctrl+C 才退
 *   npm run higgsfield:browser -- --port=9333 --direct
 *
 *   --port=<端口>   CDP 调试端口，默认 9222；别的脚本按这个端口来连。
 *   --account=<id>  用账号文件里的哪个号（默认第一个）；写 none 就不注入、纯人工登录。
 *   --proxy=<url>   出口代理。--direct 不走代理。
 *   --url=<url>     起始页，默认 https://higgsfield.ai/ai-video。
 *
 * 连它的办法（别的脚本里）：
 *   const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
 *   const context = browser.contexts()[0];
 *   const page = context.pages()[0];
 *   // 用完只 browser.close() 断开连接——CDP 连接关掉不会杀浏览器进程。
 *
 * 资料目录仍然是临时的（无痕）：登录态不落盘，这个进程一停就什么都不剩。
 */

const { config } = await import('../src/config.ts');
const {
  fetchClerkSessions,
  mintSessionToken,
  useHiggsfieldProxy
} = await import('../src/adapters/higgsfield-api.ts');
const { parseHiggsfieldAccounts } = await import('../src/jobs/higgsfield-accounts.ts');
const { chromium } = await import('playwright');
const { readFile } = await import('node:fs/promises');

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

/** 账号文件里的凭据 → 页面登录态需要的两个 cookie。 */
async function loginCookies(flags) {
  const wanted = flags.get('account');
  if (wanted === 'none') return { cookies: [], label: '不注入，等人工登录' };

  const contents = await readFile(config.higgsfieldAccountFile, 'utf8').catch(() => undefined);
  if (contents === undefined) return { cookies: [], label: '没有账号文件，等人工登录' };

  const { accounts } = parseHiggsfieldAccounts(contents);
  const account = wanted ? accounts.find((entry) => entry.sessionId.includes(wanted)) : accounts[0];
  if (!account?.clientToken) return { cookies: [], label: '账号文件里没有可用的 __client，等人工登录' };

  // `__session` 一分钟就过期，但页面里的 clerk-js 拿着 `__client` 会自己续，
  // 注入一个只是为了让首屏就是登录态、不闪一下登录页。
  const { sessions, lastActiveSessionId } = await fetchClerkSessions(config.higgsfieldClerkOrigin, account.clientToken);
  const session = sessions.find((entry) => entry.sessionId === lastActiveSessionId) ?? sessions[0];
  if (!session) return { cookies: [], label: `${account.sessionId} 的 cookie 已失效，等人工登录` };
  const sessionToken = await mintSessionToken(config.higgsfieldClerkOrigin, account.clientToken, session.sessionId);

  const siteHost = new URL(config.higgsfieldSiteOrigin).hostname;
  return {
    label: `${account.sessionId} / ${session.sessionId}`,
    cookies: [
      {
        name: '__client',
        value: account.clientToken,
        domain: new URL(config.higgsfieldClerkOrigin).hostname,
        path: '/',
        secure: true,
        sameSite: 'Lax'
      },
      { name: '__session', value: sessionToken, domain: `.${siteHost}`, path: '/', secure: true, sameSite: 'Lax' }
    ]
  };
}

const flags = parseArgs(process.argv.slice(2));
const port = Number(flags.get('port') || 9222);
const startUrl = flags.get('url') || `${config.higgsfieldSiteOrigin}/ai-video`;
const proxyUrl = resolveProxy(flags);
useHiggsfieldProxy(proxyUrl);

const { cookies, label } = await loginCookies(flags);

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  proxy: playwrightProxy(proxyUrl),
  args: [
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    '--start-maximized'
  ]
});
const context = await browser.newContext({ viewport: null });
if (cookies.length) await context.addCookies(cookies);
const page = await context.newPage();
await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((error) => {
  console.warn(`起始页没打开（${error.message}），在窗口里自己输地址也行。`);
});

console.log('');
console.log(`出口：${proxyUrl ?? '直连'}`);
console.log(`登录态：${label}`);
console.log(`CDP：http://127.0.0.1:${port}  ← 别的脚本用 chromium.connectOverCDP 连这个`);
console.log('');
console.log('这个窗口请一直开着：');
console.log('  1. 如果不是登录态，手动登一次（微软邮箱密码）。');
console.log('  2. DataDome 弹验证码就过掉它——过一次，这个会话后面都算数。');
console.log('  3. 想停就在这个终端 Ctrl+C。');
console.log('');

// 观察窗：datadome cookie 换了就说一声，方便判断验证码到底过没过。
let lastDatadome;
const timer = setInterval(async () => {
  try {
    const current = (await context.cookies()).find((cookie) => cookie.name === 'datadome')?.value;
    if (current !== lastDatadome) {
      lastDatadome = current;
      console.log(`[${new Date().toLocaleTimeString()}] datadome cookie: ${current ? `${current.slice(0, 24)}…` : '（无）'}`);
    }
  } catch {
    // 浏览器关了，下面的 disconnected 会处理。
  }
}, 5000);

browser.on('disconnected', () => {
  clearInterval(timer);
  console.log('浏览器没了，退出。');
  process.exit(0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer);
    void browser.close().finally(() => process.exit(0));
  });
}

// 挂住，别退出。
await new Promise(() => {});
