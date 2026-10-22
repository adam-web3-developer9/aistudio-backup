import { createHash, generateKeyPairSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { Server } from 'ssh2';
import { expect, it, vi } from 'vitest';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { SshGpuResultExporter } from './ssh-result-exporter.js';
import { schedulerPolicy } from './scheduler.js';
import type { ArchiveObject, ResultArchiveStorage } from './tos-result-storage.js';

it('archives through a real SSH transport only after ten minutes, persists the public result and expires it after one day', async () => {
  let now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const file = { size: 4096, sha256: 'a'.repeat(64), md5: Buffer.alloc(16, 1).toString('base64') };
  const objectStore = new Map<string, ArchiveObject>();
  const operations: string[] = [];
  const commands: string[] = [];
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const password = 'test-only-ssh-password';
  const server = new Server({ hostKeys: [keys.privateKey.export({ type: 'pkcs1', format: 'pem' })] }, connection => {
    connection.on('authentication', authentication => {
      if (authentication.method === 'password' && authentication.username === 'root' && authentication.password === password) authentication.accept();
      else authentication.reject();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptCommand, _reject, information) => {
        commands.push(information.command);
        const stream = acceptCommand();
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          operations.push(request.operation);
          const result = request.operation === 'inspect'
            ? { python: '/opt/comfy/bin/python3', outputRoot: '/output', port: 8188, pid: 123 }
            : file;
          if (request.operation === 'upload') {
            objectStore.set(new URL(request.payload.target.url).pathname.slice(1), { ...file, uploadedAt: now });
          }
          stream.exit(0);
          stream.end(JSON.stringify(result));
        });
      });
    }));
  });
  let service: ComfyService | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SSH test listener address is unavailable');
    const port = address.port;
    const exporter = new SshGpuResultExporter({
      connection: async () => ({ host: '127.0.0.1', port, username: 'root', password }),
      verifyHostKey: fingerprint => store.verifySshHostKey('1', fingerprint),
      runnerSource: 'trusted-test-runner', exporterSource: 'trusted-test-exporter',
    });
    const storage: ResultArchiveStorage = {
      uploadTarget: key => ({ url: `https://results.tos-cn-beijing.volces.com/${key}`, headers: {} }),
      head: async key => objectStore.get(key) ?? null,
      downloadUrl: key => `https://results.tos-cn-beijing.volces.com/${key}`,
      delete: async key => { objectStore.delete(key); },
    };
    const closeInstance = vi.fn().mockResolvedValue(undefined);
    const client = { health: vi.fn().mockResolvedValue(undefined), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      history: vi.fn(), findAttempt: vi.fn(), upload: vi.fn(), submit: vi.fn(), download: vi.fn() };
    const options: ComfyServiceOptions = {
      store, owner: 'test-owner', platform: { getInstanceStatus: async () => '2', openInstance: vi.fn(), closeInstance },
      client: () => client, assets: { get: vi.fn(), read: vi.fn() }, ownsAsset: () => false,
      results: { read: vi.fn(), save: vi.fn() },
      configuration: { autoOpen: false, pollIntervalMs: 1000, bootTimeoutMs: 30_000, jobTimeoutMs: 3_600_000,
        instances: [{ id: '1', baseUrl: 'https://native.waas.aigate.cc', workflowIds: ['render'] }],
        workflows: [{ id: 'render', version: '1', graph: { '1': { class_type: 'Render', inputs: { filename_prefix: '' } } },
          bindings: { output: { nodeId: '1', input: 'filename_prefix', kind: 'output-prefix' } }, outputNodeIds: ['1'] }] },
      resultArchive: { storage, exporter: () => exporter, keyPrefix: 'comfy-results', storageIdentity: createHash('sha256').update('test-bucket').digest('hex') },
    };
    options.configuration.scheduler = schedulerPolicy(options.configuration);
    service = new ComfyService(options);
    store.updateInstance('1', { state: 'ready', idle_since: now });
    const job = service.submit({ adapterId: 'comfyui-v1', requestKey: 'ssh-integration', workflowId: 'render',
      transport: 'direct', values: {}, media: {}, directMedia: {} }).job;
    store.claim('1', ['render'], now);
    store.updateJob(job.id, { stage: 'succeeded', result_pending: 1, result: JSON.stringify({
      videoUrl: 'https://native.waas.aigate.cc/view?filename=video.mp4&type=output',
      output: { filename: 'video.mp4', subfolder: '', type: 'output', nodeId: '1' },
    }) });
    store.releaseSlot(job.id);
    now += 599_999;
    await service.tick();
    await service.archive!.settled();
    expect(operations).toEqual([]);
    expect(closeInstance).not.toHaveBeenCalled();
    now += 1;
    await service.tick();
    await service.archive!.settled();
    expect(operations).toEqual(['inspect', 'describe', 'inspect', 'upload']);
    expect(commands.every(command => !command.includes(password) && !command.includes(job.id) && !command.includes('results.tos'))).toBe(true);
    expect(store.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 0, collected_at: null });
    const archived = service.publicJob(store.get(job.id)!);
    expect(archived).toMatchObject({ status: 'succeeded', result: { storage: 'tos', expiresAt: now + 86_400_000 } });
    await service.tick();
    expect(closeInstance).toHaveBeenCalledOnce();
    expect(client.download).not.toHaveBeenCalled();
    await service.close();
    service = new ComfyService(options);
    expect(service.publicJob(store.get(job.id)!)).toMatchObject({ result: archived.result });
    now += 86_400_000;
    await service.tick();
    await service.archive!.settled();
    expect(objectStore.size).toBe(0);
    expect(service.publicJob(store.get(job.id)!)).toMatchObject({ status: 'failed', stage: 'result_expired', error: { code: 'COMFY_RESULT_EXPIRED' } });
    expect(operations).toHaveLength(4);
  } finally {
    await service?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    clock.mockRestore();
  }
}, 15000);
