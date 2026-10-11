import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TokenFilePruner,
  TokenFileWatcher,
  hailuoSessionId,
  parseHailuoTokens,
  removeTokenFromFile
} from './token-file.js';

/** A syntactically valid JWT whose payload names `userId`; the signature is irrelevant. */
function jwt(userId: string, extra: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000, user: { id: userId, name: `探索者${userId}` }, ...extra }))
    .toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('parseHailuoTokens', () => {
  it('derives a stable session id from the account, not the line number', () => {
    const first = parseHailuoTokens(`${jwt('1')}\n${jwt('2')}\n${jwt('3')}\n`);
    const withoutMiddleLine = parseHailuoTokens(`${jwt('1')}\n${jwt('3')}\n`);

    expect(first.tokens.map((t) => t.sessionId)).toEqual(['hailuo-1', 'hailuo-2', 'hailuo-3']);
    expect(withoutMiddleLine.tokens.map((t) => t.sessionId)).toEqual(['hailuo-1', 'hailuo-3']);
  });

  it('skips comments and blank lines and reports duplicate accounts', () => {
    const parsed = parseHailuoTokens(`# accounts\r\n\r\n${jwt('7')}\r\n${jwt('7', { exp: 1 })}\r\n`);

    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]).toMatchObject({ sessionId: 'hailuo-7', line: 3 });
    expect(parsed.duplicates).toEqual([{ sessionId: 'hailuo-7', line: 4 }]);
  });

  it('falls back to a token hash when the token is not a decodable JWT', () => {
    expect(hailuoSessionId('opaque-token')).toMatch(/^hailuo-[0-9a-f]{12}$/);
    expect(hailuoSessionId('opaque-token')).toBe(hailuoSessionId('opaque-token'));
    expect(hailuoSessionId('opaque-token')).not.toBe(hailuoSessionId('other-token'));
  });
});

describe('TokenFileWatcher', () => {
  it('delivers the file at start and again when its contents change', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hailuo-watch-'));
    const filePath = path.join(directory, 'tokens.txt');
    await writeFile(filePath, `${jwt('1')}\n`, 'utf8');

    const onChange = vi.fn();
    const watcher = new TokenFileWatcher(filePath, onChange, { pollIntervalMs: 20, debounceMs: 5 });
    try {
      await watcher.start();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0]?.[1]).toEqual({ initial: true });

      await writeFile(filePath, `${jwt('1')}\n${jwt('2')}\n`, 'utf8');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
      expect(onChange.mock.calls[1]?.[0].tokens.map((t: { sessionId: string }) => t.sessionId))
        .toEqual(['hailuo-1', 'hailuo-2']);
      expect(onChange.mock.calls[1]?.[1]).toEqual({ initial: false });

      // Same contents rewritten: nothing to apply.
      await writeFile(filePath, `${jwt('1')}\n${jwt('2')}\n`, 'utf8');
      await watcher.check();
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      watcher.stop();
    }
  });

  it('retries a change whose handler failed instead of treating it as applied', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hailuo-watch-'));
    const filePath = path.join(directory, 'tokens.txt');
    await writeFile(filePath, `${jwt('1')}\n`, 'utf8');

    const onChange = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('session store offline'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const watcher = new TokenFileWatcher(filePath, onChange, { pollIntervalMs: 60_000, onError });
    try {
      await watcher.start();
      await writeFile(filePath, `${jwt('2')}\n`, 'utf8');

      await watcher.check();
      expect(onError).toHaveBeenCalledOnce();
      await watcher.check();
      expect(onChange).toHaveBeenCalledTimes(3);
    } finally {
      watcher.stop();
    }
  });
});

describe('TokenFilePruner', () => {
  it('removes the exact token while preserving comments, blank lines and newline style', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hailuo-tokens-'));
    const filePath = path.join(directory, 'tokens.txt');
    await writeFile(filePath, '# accounts\r\nfirst\r\n\r\nsecond\r\n', 'utf8');

    await expect(removeTokenFromFile(filePath, 'first')).resolves.toBe(true);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('# accounts\r\n\r\nsecond\r\n');
  });

  it('serializes simultaneous removals', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hailuo-tokens-'));
    const filePath = path.join(directory, 'tokens.txt');
    await writeFile(filePath, 'first\nsecond\nthird\n', 'utf8');
    const pruner = new TokenFilePruner(filePath);

    await Promise.all([pruner.remove('first'), pruner.remove('second')]);

    await expect(readFile(filePath, 'utf8')).resolves.toBe('third\n');
  });
});
