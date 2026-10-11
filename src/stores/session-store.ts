import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserCookie, SessionRecord } from '../types.js';

export class SessionStore {
  private readonly directory: string;

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, 'sessions');
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  async put(id: string, adapterId: string, cookies: BrowserCookie[]): Promise<SessionRecord> {
    const session: SessionRecord = {
      id,
      adapterId,
      cookies,
      updatedAt: new Date().toISOString()
    };
    await writeFile(this.filePath(id), JSON.stringify(session, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    return session;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    try {
      const content = await readFile(this.filePath(id), 'utf8');
      return JSON.parse(content) as SessionRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(): Promise<SessionRecord[]> {
    const entries = await readdir(this.directory);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.get(entry.slice(0, -'.json'.length)))
    );
    return records
      .filter((record): record is SessionRecord => Boolean(record))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.filePath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private filePath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.directory, `${safeId}.json`);
  }
}
