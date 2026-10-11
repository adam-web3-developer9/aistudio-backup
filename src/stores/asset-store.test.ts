import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetStore } from './asset-store.js';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

describe('AssetStore', () => {
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
