#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE64URL_CHAR = /[A-Za-z0-9_-]/;
const JWT_START = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\./g;

// For fixed-size HMAC JWT algorithms, this also lets us discard base64url
// characters that may have been pasted immediately after the token.
const FIXED_SIGNATURE_LENGTHS = {
  HS256: 43,
  HS384: 64,
  HS512: 86,
};

function decodeJsonPart(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hasCanonicalBase64UrlEncoding(part) {
  try {
    return Buffer.from(part, 'base64url').toString('base64url') === part;
  } catch {
    return false;
  }
}

export function extractTokens(text) {
  const tokens = [];
  const seen = new Set();

  for (const match of text.matchAll(JWT_START)) {
    const prefix = match[0];
    const firstDot = prefix.indexOf('.');
    const secondDot = prefix.length - 1;
    const headerPart = prefix.slice(0, firstDot);
    const payloadPart = prefix.slice(firstDot + 1, secondDot);
    const header = decodeJsonPart(headerPart);
    const payload = decodeJsonPart(payloadPart);

    if (
      !header ||
      !payload ||
      !hasCanonicalBase64UrlEncoding(headerPart) ||
      !hasCanonicalBase64UrlEncoding(payloadPart) ||
      header.typ !== 'JWT' ||
      typeof header.alg !== 'string'
    ) {
      continue;
    }

    const signatureStart = match.index + prefix.length;
    let signatureEnd = signatureStart;
    while (
      signatureEnd < text.length &&
      BASE64URL_CHAR.test(text[signatureEnd])
    ) {
      signatureEnd += 1;
    }

    const availableSignature = text.slice(signatureStart, signatureEnd);
    const fixedLength = FIXED_SIGNATURE_LENGTHS[header.alg];
    const signaturePart = fixedLength
      ? availableSignature.slice(0, fixedLength)
      : availableSignature;

    if (
      !signaturePart ||
      (fixedLength && signaturePart.length !== fixedLength) ||
      !hasCanonicalBase64UrlEncoding(signaturePart)
    ) {
      continue;
    }

    const token = `${headerPart}.${payloadPart}.${signaturePart}`;
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

function printUsage() {
  console.log('用法: node scripts/extract-tokens.mjs [输入文件] [输出文件]');
  console.log('默认: 输入 input.txt，输出 tokens_new.txt');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printUsage();
    return;
  }

  const inputPath = resolve(args[0] ?? 'input.txt');
  const outputPath = resolve(args[1] ?? 'tokens_new.txt');
  const text = await readFile(inputPath, 'utf8');
  const tokens = extractTokens(text);

  await writeFile(outputPath, tokens.length ? `${tokens.join('\n')}\n` : '', 'utf8');
  console.log(`已提取 ${tokens.length} 个 token，写入 ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`提取失败: ${error.message}`);
    process.exitCode = 1;
  });
}
