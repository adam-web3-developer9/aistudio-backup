import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

const resetScript = `
const status = document.getElementById('status');
let token = new URLSearchParams(location.search).get('token');
history.replaceState(null, '', location.pathname);
if (!token) { status.textContent = '重置链接无效或已过期，请在客户端重新申请。'; document.getElementById('form').hidden = true; }
document.getElementById('copy').addEventListener('click', async () => {
  if (!token) return;
  try { await navigator.clipboard.writeText(token); status.textContent = '重置凭据已复制，可粘贴到客户端。'; }
  catch { status.textContent = '无法复制，请直接在本页重置密码。'; }
});
document.getElementById('form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  if (password !== confirm) { status.textContent = '两次密码不一致。'; return; }
  const button = document.getElementById('submit'); button.disabled = true;
  try {
    const response = await fetch('/api/auth/reset-password', {method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,newPassword:password})});
    if (!response.ok) { status.textContent = '无法重置：链接可能已过期，请重新申请。'; return; }
    token = null;
    document.getElementById('form').reset(); document.getElementById('form').hidden = true;
    status.textContent = '密码已重置，请返回客户端登录。';
  } catch { status.textContent = '服务连接失败，请稍后重试。'; }
  finally { button.disabled = false; }
});`;

function protectPage(reply: FastifyReply, script?: string) {
  const scriptPolicy = script ? `'sha256-${createHash('sha256').update(script).digest('base64')}'` : "'none'";
  return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer').header('x-content-type-options', 'nosniff')
    .header('content-security-policy', `default-src 'none'; script-src ${scriptPolicy}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}

export function registerAccountPages(app: FastifyInstance): void {
  app.get('/account/verified', async (request, reply) => {
    const failed = typeof (request.query as { error?: unknown }).error === 'string';
    const title = failed ? '邮箱验证未完成' : '邮箱验证已完成';
    const message = failed ? '验证链接无效或已过期，请返回 AI Studio 客户端重新发送验证邮件。' : '邮箱验证成功，请返回 AI Studio 客户端登录。';
    return protectPage(reply).send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`);
  });
  app.get('/account/reset-password', async (_request, reply) => protectPage(reply, resetScript).send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>重置密码</title></head><body><main><h1>重置密码</h1><p id="status" role="status">请设置至少8字符的新密码，重置后返回客户端登录。</p><form id="form"><p><label>新密码 <input id="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label></p><p><label>确认密码 <input id="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label></p><button id="submit" type="submit">重置密码</button> <button id="copy" type="button">复制重置凭据到客户端</button></form></main><script>${resetScript}</script></body></html>`));
}
