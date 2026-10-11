import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetRecord } from '../types.js';

const META_SUFFIX = '.meta.json';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

export interface AssetStoreOptions {
  onError?: (error: unknown, fileName: string) => void;
}

/**
 * Uploaded images. The bytes always lived on disk; the index now does too, so
 * an asset uploaded before a restart is still usable for a job created after it.
 */
export class AssetStore {
  private readonly assets = new Map<string, AssetRecord>();
  private readonly directory: string;

  constructor(dataDir: string, private readonly options: AssetStoreOptions = {}) {
    this.directory = path.join(dataDir, 'uploads');
  }

  /** Rebuild the index from the upload directory. */
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    for (const entry of await readdir(this.directory)) {
      if (entry.endsWith(META_SUFFIX) || entry.endsWith('.tmp')) continue;
      const id = path.parse(entry).name;
      if (!id.startsWith('asset_')) continue;
      const filePath = path.join(this.directory, entry);
      try {
        const record = await this.readMeta(id) ?? await describeFile(id, entry, filePath);
        // The data directory may have moved; the file we just found is the truth.
        this.assets.set(id, { ...record, id, path: filePath });
      } catch (error) {
        this.options.onError?.(error, entry);
      }
    }
  }

  async save(input: {
    originalName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<AssetRecord> {
    const id = `asset_${randomUUID()}`;
    const extension = safeExtension(input.originalName);
    const filePath = path.join(this.directory, `${id}${extension}`);
    await writeFile(filePath, input.buffer, { flag: 'wx', mode: 0o600 });

    const asset: AssetRecord = {
      id,
      originalName: path.basename(input.originalName),
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      path: filePath,
      createdAt: new Date().toISOString()
    };

    this.assets.set(id, asset);
    // Best effort: without the sidecar the asset is still recovered from the file itself.
    await writeFile(this.metaPath(id), JSON.stringify(asset, null, 2), {encoding: 'utf8', mode: 0o600})
      .catch((error: unknown) => this.options.onError?.(error, `${id}${META_SUFFIX}`));
    return asset;
  }

  get(id: string): AssetRecord | undefined {
    return this.assets.get(id);
  }

  async read(id: string): Promise<Buffer | undefined> {
    const asset = this.assets.get(id);
    return asset ? readFile(asset.path) : undefined;
  }

  private async readMeta(id: string): Promise<AssetRecord | undefined> {
    try {
      const record = JSON.parse(await readFile(this.metaPath(id), 'utf8')) as AssetRecord;
      return record?.id === id && typeof record.mimeType === 'string' ? record : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private metaPath(id: string): string {
    return path.join(this.directory, `${id}${META_SUFFIX}`);
  }
}

/** Uploads from before sidecars existed: recover what the file itself can tell us. */
async function describeFile(id: string, fileName: string, filePath: string): Promise<AssetRecord> {
  const info = await stat(filePath);
  const extension = path.extname(fileName).toLowerCase();
  return {
    id,
    originalName: fileName,
    mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
    size: info.size,
    path: filePath,
    createdAt: (info.birthtime.getTime() > 0 ? info.birthtime : info.mtime).toISOString()
  };
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}
