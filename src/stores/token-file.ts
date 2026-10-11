import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeHailuoToken } from '../adapters/hailuo-api.js';

export interface HailuoTokenConfig {
  /**
   * Stable per-account id: `hailuo-<userId>` from the JWT payload, or a hash of
   * the token when it cannot be decoded. Never derived from the line number, so
   * removing or reordering lines does not re-label the remaining accounts.
   */
  sessionId: string;
  token: string;
  /** 1-based line in the token file, for operator messages. */
  line: number;
}

export interface ParsedTokenFile {
  tokens: HailuoTokenConfig[];
  /** Lines skipped because an earlier line already names the same account. */
  duplicates: Array<{ sessionId: string; line: number }>;
}

export function hailuoSessionId(token: string): string {
  const userId = describeHailuoToken(token)?.userId;
  if (userId) return `hailuo-${userId}`;
  return `hailuo-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/** One token per line; blank lines and `#` comments are ignored. */
export function parseHailuoTokens(contents: string): ParsedTokenFile {
  const tokens: HailuoTokenConfig[] = [];
  const duplicates: ParsedTokenFile['duplicates'] = [];
  const seen = new Set<string>();

  contents.split(/\r?\n/).forEach((raw, index) => {
    const token = raw.trim();
    if (!token || token.startsWith('#')) return;
    const sessionId = hailuoSessionId(token);
    const line = index + 1;
    if (seen.has(sessionId)) {
      duplicates.push({ sessionId, line });
      return;
    }
    seen.add(sessionId);
    tokens.push({ sessionId, token, line });
  });

  return { tokens, duplicates };
}

export async function readHailuoTokenFile(filePath: string): Promise<ParsedTokenFile> {
  try {
    return parseHailuoTokens(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tokens: [], duplicates: [] };
    throw error;
  }
}

export interface TokenFileWatcherOptions<T = ParsedTokenFile> {
  /** Fallback poll — `fs.watch` misses the atomic rename-saves some editors do. */
  pollIntervalMs?: number;
  /** Quiet period after a change event before the file is re-read. */
  debounceMs?: number;
  /** How a line-oriented credential file is read; defaults to Hailuo's token format. */
  parse?: (contents: string) => T;
  onError?: (error: unknown) => void;
}

export type TokenFileChangeHandler<T = ParsedTokenFile> = (
  parsed: T,
  context: { initial: boolean }
) => void | Promise<void>;

/**
 * Keeps the running service in step with the token file.
 *
 * `start()` delivers the file once, then re-delivers it whenever its contents
 * change (detected by `fs.watch` on the directory plus a low-frequency poll).
 * A missing file after start-up is treated as a transient editor state and
 * ignored rather than wiping every account.
 */
export class TokenFileWatcher<T = ParsedTokenFile> {
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private lastFingerprint?: string;
  private running = false;
  private applying = false;
  private recheck = false;

  constructor(
    readonly filePath: string,
    private readonly onChange: TokenFileChangeHandler<T>,
    private readonly options: TokenFileWatcherOptions<T> = {}
  ) {}

  async start(): Promise<T> {
    const contents = await this.readContents() ?? '';
    const parsed = this.parse(contents);
    await this.onChange(parsed, { initial: true });
    this.lastFingerprint = fingerprint(contents);
    this.running = true;

    try {
      const fileName = path.basename(this.filePath);
      this.watcher = watch(path.dirname(this.filePath), (_event, changed) => {
        if (!changed || changed.toString() === fileName) this.schedule();
      });
      this.watcher.on('error', (error) => this.options.onError?.(error));
    } catch (error) {
      // Polling alone still works; just slower to notice edits.
      this.options.onError?.(error);
    }

    this.pollTimer = setInterval(() => void this.check(), this.options.pollIntervalMs ?? 5_000);
    this.pollTimer.unref?.();
    return parsed;
  }

  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = undefined;
    this.debounceTimer = undefined;
  }

  /** Re-read now instead of waiting for the next poll; resolves once applied. */
  async check(): Promise<void> {
    if (!this.running) return;
    if (this.applying) {
      this.recheck = true;
      return;
    }
    this.applying = true;
    try {
      const contents = await this.readContents();
      if (contents === undefined) return;
      const current = fingerprint(contents);
      if (current === this.lastFingerprint) return;
      await this.onChange(this.parse(contents), { initial: false });
      this.lastFingerprint = current;
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.applying = false;
      if (this.recheck) {
        this.recheck = false;
        this.schedule();
      }
    }
  }

  private parse(contents: string): T {
    return this.options.parse
      ? this.options.parse(contents)
      : parseHailuoTokens(contents) as unknown as T;
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.check(), this.options.debounceMs ?? 500);
  }

  private async readContents(): Promise<string | undefined> {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function fingerprint(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Serializes token-file edits so simultaneous balance refreshes cannot lose updates. */
export class TokenFilePruner {
  private pending = Promise.resolve();

  constructor(private readonly filePath: string) {}

  remove(token: string): Promise<boolean> {
    const operation = this.pending.then(() => removeTokenFromFile(this.filePath, token));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export async function removeTokenFromFile(filePath: string, token: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(contents);
  const lines = contents.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const retained = lines.filter((line) => line.trim() !== token);
  if (retained.length === lines.length) return false;

  const output = retained.join(newline) + (hadTrailingNewline ? newline : '');
  await writeFile(filePath, output, 'utf8');
  return true;
}
