#!/usr/bin/env node
/**
 * Read-only diagnostic for the Miora channel. Reads a site-state export, picks
 * the newest authToken + the miora.design cookie jar, and calls two GET-only
 * endpoints (credit, model catalog) both WITHOUT and WITH the cookie header, so
 * we can see exactly what the platform requires. Submits nothing, spends no
 * credits, never touches the refresh token.
 *
 *   node scripts/miora-probe.mjs <export.json>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
const API = 'https://miora.design/api/ai';
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return {}; }
}

const inputPath = resolve(process.argv[2] || 'input.json');
const state = JSON.parse(await readFile(inputPath, 'utf8'));
const ls = state.localStorage ?? {};
const blob = JSON.stringify(state);
const candidates = [...new Set([ls.authToken, (state.cookies ?? []).find((c) => c.name === 'authToken')?.value, ...(blob.match(JWT) ?? [])].filter(Boolean))];
const authToken = candidates.map((t) => ({ t, iat: Number(claims(t).iat) || 0 })).sort((a, b) => b.iat - a.iat)[0]?.t;
const cookie = (state.cookies ?? [])
  .filter((c) => /(^|\.)miora\.design$/.test(String(c.domain || '')))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

const c = claims(authToken);
console.log('authToken:', `…${String(authToken).slice(-8)}`, 'sub:', c.sub, 'exp:', c.exp ? new Date(c.exp * 1000).toISOString() : '?', 'scopes:', JSON.stringify(c.scopes));
console.log('cookie:', cookie ? `${cookie.split('; ').length} 个` : '无');

function headers(withCookie) {
  const h = {
    authorization: `Bearer ${authToken}`,
    'x-product': 'miora',
    'x-source': 'web',
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: 'https://miora.design',
    referer: 'https://miora.design/',
    'user-agent': UA
  };
  if (withCookie && cookie) h.cookie = cookie;
  return h;
}

async function probe(label, path, withCookie) {
  try {
    const res = await fetch(`${API}${path}`, { headers: headers(withCookie) });
    const text = await res.text();
    console.log(`\n[${label}] GET ${path}  -> HTTP ${res.status}`);
    console.log('  ', text.slice(0, 240).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(`\n[${label}] GET ${path}  -> ERROR ${e?.message || e}`);
  }
}

await probe('无cookie', '/quota/credit', false);
await probe('有cookie', '/quota/credit', true);
await probe('有cookie', '/cloud-agent/media-models?lang=zh-CN', true);
