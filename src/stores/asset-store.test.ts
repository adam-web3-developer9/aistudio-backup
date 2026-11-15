import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStore, UPLOAD_RETENTION_MS } from './asset-store.js';

const cleanup: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

describe('AssetStore', () => {
  it('expires bytes and metadata at 24 hours without extending lifetime on use or restart', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-upload-expiry-'));
    cleanup.push(dataDir);
    vi.useFakeTimers();
    const start = Date.parse('2026-11-01T00:00:00Z');
    vi.setSystemTime(start);
    const first = new AssetStore(dataDir);
    await first.initialize();
    const old = await first.save({ originalName: 'old.png', mimeType: 'image/png', buffer: onePixelPng });
    vi.setSystemTime(start + UPLOAD_RETENTION_MS - 1);
    expect(first.get(old.id)).toBeDefined();
    await expect(first.read(old.id)).resolves.toEqual(onePixelPng);
    const recent = await first.save({ originalName: 'recent.png', mimeType: 'image/png', buffer: onePixelPng });
    vi.setSystemTime(start + UPLOAD_RETENTION_MS);
    const restored = new AssetStore(dataDir);
    await restored.initialize();
    expect(restored.get(old.id)).toBeUndefined();
    await expect(restored.read(old.id)).resolves.toBeUndefined();
    expect(restored.get(recent.id)).toBeDefined();
    await expect(restored.prune()).resolves.toEqual({ assets: 1, metadata: 1, bytes: onePixelPng.byteLength });
    expect(await readdir(path.join(dataDir, 'uploads'))).toEqual(expect.arrayContaining([path.basename(recent.path), `${recent.id}.meta.json`]));
    expect(await readdir(path.join(dataDir, 'uploads'))).not.toContain(path.basename(old.path));
    await expect(restored.prune()).resolves.toEqual({ assets: 0, metadata: 0, bytes: 0 });
  });

  it('uses persisted file write time for legacy uploads and removes expired orphan metadata', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-legacy-expiry-'));
    cleanup.push(dataDir);
    const uploads = path.join(dataDir, 'uploads');
    await mkdir(uploads);
    const old = new Date(Date.now() - UPLOAD_RETENTION_MS - 1000);
    for (const name of ['asset_legacy.png', 'asset_missing.meta.json']) {
      await writeFile(path.join(uploads, name), onePixelPng);
      await utimes(path.join(uploads, name), old, old);
    }
    const store = new AssetStore(dataDir);
    await store.initialize();
    expect(store.get('asset_legacy')).toBeUndefined();
    await expect(store.prune()).resolves.toEqual({ assets: 1, metadata: 1, bytes: onePixelPng.byteLength });
    expect(await readdir(uploads)).toEqual([]);
  });

  it('finds uploads from a previous run, with or without a metadata sidecar', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-assets-'));
    const first = new AssetStore(dataDir);
    await first.initialize();
    const saved = await first.save({ originalName: 'portrait.PNG', mimeType: 'image/png', buffer: onePixelPng });

    // An upload written by the version that kept no sidecar.
    await mkdir(path.join(dataDir, 'uploads'), { recursive: true });
    await writeFile(path.join(dataDir, 'uploads', 'asset_legacy.png'), onePixelPng);

    const second = new AssetStore(dataDir);
    await second.initialize();

    expect(second.get(saved.id)).toMatchObject({
      id: saved.id,
      originalName: 'portrait.PNG',
      mimeType: 'image/png',
      size: onePixelPng.byteLength,
      path: saved.path
    });
    expect(second.get('asset_legacy')).toMatchObject({
      id: 'asset_legacy',
      mimeType: 'image/png',
      size: onePixelPng.byteLength
    });
    await expect(second.read('asset_legacy')).resolves.toEqual(onePixelPng);
  });
});
