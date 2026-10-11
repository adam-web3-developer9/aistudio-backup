#!/usr/bin/env node

/**
 * 加一个 Miora 账号：开无痕浏览器，人工登录 miora.design，自动取令牌。
 *
 * 浏览器用本机 Chrome 的临时资料目录（无痕：和日常 Chrome 隔开，关掉即清空），
 * 所以连着加好几个号不用来回退出登录。登录后 localStorage 里出现 authToken，
 * 就把整站状态（cookies + localStorage）存成一份导出放进 MIORA_IMPORT_DIR，
 * 再走和 `npm run miora:import` 一样的导入 —— T-Sec 风控 cookie 也一起带上。
 *
 * 用法：
 *   npm run miora:login
 *   npm run miora:login -- --browser=msedge --proxy=http://127.0.0.1:7897
 *
 *   --browser=<名字> chrome（默认）/ msedge / chromium。
 *   --exe=<路径>     直接指定浏览器可执行文件。
 *   --proxy=<url>    出口代理（默认 MIORA_PROXY_URL，没配就直连）。
 *   --timeout=<分钟> 等人工登录的上限，默认 15。
 */

const { config } = await import('../src/config.ts');
const { describeMioraToken, hasUsableScopes } = await import('../src/adapters/miora-api.ts');
const { importMioraExports } = await import('../src/jobs/miora-import.ts');
const { chromium } = await import('playwright');
const { mkdir, writeFile } = await import('node:fs/promises');
const { existsSync } = await import('node:fs');
const path = (await import('node:path')).default;

const SITE = 'https://miora.design/';

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

/** 页面里 miora.design 的 localStorage；页面正在跳转时读不到就当空。 */
async function readLocalStorage(page) {
  if (!page.url().startsWith(SITE)) return {};
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage))).catch(() => ({}));
}

/** 当前整站状态：cookies + 带 authToken 的那页（没有就随便一页）的 localStorage。 */
async function snapshot(context) {
  let storage = {};
  let url;
  for (const page of context.pages()) {
    const current = await readLocalStorage(page);
    if (Object.keys(current).length > Object.keys(storage).length || current.authToken) {
      storage = current;
      url = page.url();
    }
    if (current.authToken) break;
  }
  const cookies = await context.cookies(SITE).catch(() => []);
  return { url, cookies, localStorage: storage };
}

const hasToken = (state) => Boolean(state?.localStorage.authToken
  || state?.cookies.some((cookie) => cookie.name === 'authToken' && cookie.value));

/**
 * 等到 localStorage 或 cookie 里出现 authToken，再多等几秒让网站把 refreshToken /
 * 用户信息 / 风控 cookie 写完。每秒留一份快照，窗口在这之后被关也不丢。
 */
async function waitForLogin(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let seenAt;
  while (Date.now() < deadline) {
    if (!context.pages().length) {
      if (hasToken(last)) return last;
      throw new Error('浏览器窗口被关掉了，没拿到令牌');
    }
    const current = await snapshot(context);
    if (hasToken(current) || !hasToken(last)) last = current;
    if (hasToken(last)) {
      seenAt ??= Date.now();
      if (Date.now() - seenAt >= 3_000) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`等登录超时（${Math.round(timeoutMs / 60_000)} 分钟）`);
}

const flags = parseArgs(process.argv.slice(2));
const timeoutMs = Math.max(1, Number(flags.get('timeout') || 15)) * 60_000;
const proxyUrl = flags.get('proxy') || config.mioraProxyUrl;
const browser = resolveBrowser(flags);

console.log(`浏览器：${browser.label}（无痕：临时资料目录，关掉即清空）`);
console.log(`出口：${proxyUrl ?? '直连'}`);

const instance = await chromium.launch({
  headless: false,
  ...(browser.channel ? { channel: browser.channel } : {}),
  ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
  proxy: playwrightProxy(proxyUrl),
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
});

let state;
try {
  const context = await instance.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded' }).catch((error) => {
    console.warn(`首页没打开（${error.message}）；可以在窗口里自己访问 ${SITE}`);
  });

  console.log('');
  console.log('在打开的窗口里登录 miora.design，登进去后这边会自动取令牌并关窗。');
  console.log(`最多等 ${timeoutMs / 60_000} 分钟。`);
  console.log('');

  state = await waitForLogin(context, timeoutMs);
} finally {
  await instance.close().catch(() => {});
}

await mkdir(config.mioraImportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const exportFile = path.join(config.mioraImportDir, `login-${stamp}.json`);
await writeFile(exportFile, JSON.stringify(state, null, 2), 'utf8');
console.log(`已存导出：${exportFile}`);

const report = await importMioraExports(config.mioraImportDir, config.mioraAccountFile);
const result = report.results.find((entry) => entry.source === exportFile);
if (!result) {
  const skipped = report.skipped.find((entry) => entry.file === exportFile);
  throw new Error(`导出里没取到账号：${skipped?.reason ?? '未知原因'}`);
}
const { tokens } = result;
console.log(`账号：        ${result.email ?? result.sessionId}（${result.status}）`);
console.log(`authToken到期: ${describeMioraToken(tokens.authToken)?.expiresAt ?? '(未知)'}`);
console.log(`scopes:       ${hasUsableScopes(tokens.authToken) ? '["*"]' : '空（不影响生成）'}`);
console.log(`refreshToken: ${tokens.refreshToken ? '有（可自动续期）' : '无 ⚠ authToken 到期后需重新登录'}`);
console.log(`cookie:       ${tokens.cookie ? `${tokens.cookie.split('; ').length} 个` : '无 ⚠ 可能被风控 401'}`);
console.log(report.written ? `已写入 ${config.mioraAccountFile}，网关运行中会自己重读。` : '账号文件无需改动');
