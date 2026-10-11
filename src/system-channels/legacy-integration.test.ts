import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { MioraAdapter } from '../adapters/miora-adapter.js';
import { readMioraTokens } from '../adapters/miora-api.js';
import { BrowserPool } from '../browser/browser-pool.js';
import { ProjectStore } from '../projects/store.js';
import { SystemJobStore } from '../system-jobs/store.js';
import type { SystemRuntime } from '../system/index.js';
import { ChannelJobBridge, type LegacyChannelRuntime } from './bridge.js';
import { ChannelStore } from './store.js';

test('real buildApp preserves enabled vault accounts, runs the original Miora worker and blocks legacy HTTP access', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-managed-integration-'));
  const originalConfig = {
    dataDir: config.dataDir, apiKey: config.apiKey, hailuoTokenFile: config.hailuoTokenFile,
    dreamMakerAccountFile: config.dreamMakerAccountFile, higgsfieldAccountFile: config.higgsfieldAccountFile,
    mioraAccountFile: config.mioraAccountFile, mioraImportDir: config.mioraImportDir,
  };
  const db = new Database(':memory:');
  let app: FastifyInstance | undefined;
  let bridge: ChannelJobBridge | undefined;
  try {
    Object.assign(config, {
      dataDir: path.join(directory, 'data'), apiKey: 'isolated-legacy-api-key',
      hailuoTokenFile: path.join(directory, 'tokens.txt'), dreamMakerAccountFile: path.join(directory, 'dreammaker.txt'),
      higgsfieldAccountFile: path.join(directory, 'higgsfield.txt'), mioraAccountFile: path.join(directory, 'miora.txt'),
      mioraImportDir: path.join(directory, 'imports'),
    });
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile, config.dreamMakerAccountFile, config.higgsfieldAccountFile, config.mioraAccountFile].map(file => writeFile(file, '')));
    const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'real-worker-isolated-user', exp: 4102444800 })).toString('base64url') + '.fake';
    const channels = new ChannelStore(db, Buffer.alloc(32, 20).toString('base64'));
    const managed = channels.import(jwt);
    channels.update(managed.id, { enabled: true });
    const credits = vi.spyOn(MioraAdapter.prototype, 'getCreditsFromCookies').mockImplementation(async cookies => {
      expect(readMioraTokens(cookies)?.authToken).toBe(jwt);
      return { totalCredits: 1000, breakdown: [] };
    });
    const paid = vi.spyOn(MioraAdapter.prototype, 'runWithoutBrowser').mockImplementation((cookies, input) => {
      expect(readMioraTokens(cookies)?.authToken).toBe(jwt);
      expect(input.allowPaidRetries).toBe(false);
      return (async () => {
        await input.beforeSubmit?.();
        return { videoUrl: 'https://isolated.miora.design/worker-result.mp4' };
      })();
    });
    const browserWarmup = vi.spyOn(BrowserPool.prototype, 'initialize');
    // Any accidental global fetch fails instead of reaching a provider or deployment.
    const externalFetch = vi.fn(async () => { throw new Error('External fetch is forbidden in isolated worker integration'); });
    vi.stubGlobal('fetch', externalFetch);
    app = await buildApp({ managedChannels: channels, warmup: false });
    await app.ready();
    expect(browserWarmup).not.toHaveBeenCalled();
    expect(channels.row(managed.id)?.enabled).toBe(1);
    const legacy = (app as unknown as { channelRuntime: LegacyChannelRuntime }).channelRuntime;
    expect((await legacy.sessions.get(managed.id))?.adapterId).toBe(new MioraAdapter().id);
    expect((await legacy.accountPool.snapshot()).map(account => account.sessionId)).toContain(managed.id);

    const owner = { id: 'owner', sessionId: 'isolated-session', emailVerified: true, cloudEligible: true, sharingEligible: true };
    const projects = new ProjectStore(db);
    projects.share('project', owner, { entities: [{ type: 'shot', id: 'shot', fields: { prompt: 'private-isolated-prompt' } }], collections: {} }, []);
    const jobs = new SystemJobStore(db, projects);
    db.exec('CREATE TABLE shared_project_media(project_id TEXT,generation INTEGER,entity_type TEXT,entity_id TEXT,hash TEXT,size INTEGER,mime TEXT,PRIMARY KEY(project_id,generation,entity_type,entity_id,hash))');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createHash('sha256').update(png).digest('hex');
    db.prepare('INSERT INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run('project', 1, 'shot', 'shot', hash, png.length, 'image/png');
    const blobs = new Map<string, Buffer>([[hash, png]]);
    const fetchResult = vi.fn(async () => new Response(Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109])));
    bridge = new ChannelJobBridge({
      runtime: { db, assertPrincipalCurrent: () => owner } as unknown as SystemRuntime, channels, jobs, legacy,
      blobs: { get: async id => blobs.get(id) ?? null, put: async (id, bytes) => { blobs.set(id, bytes); } },
      fetchResult, pollIntervalMs: 5,
    });
    const created = jobs.create('project', owner, { requestId: 'original-worker', generation: 1,
      target: { type: 'shot', id: 'shot' }, inputVersion: 0, executor: 'server', kind: 'miora.video',
      parameters: { text: 'private-isolated-prompt', mediaHashes: [hash] } });
    await bridge.submit(created.job.id, owner);
    await vi.waitFor(() => expect(jobs.row(created.job.id)?.status).toBe('succeeded'), { timeout: 1000, interval: 5 });
    expect(paid).toHaveBeenCalledTimes(1);
    expect(credits).toHaveBeenCalled();
    expect(fetchResult).toHaveBeenCalledTimes(1);
    expect(legacy.jobs.list()[0]?.adapterId).toBe(new MioraAdapter().id);
    expect(Object.keys(projects.snapshot('project', owner).entities[0]?.fields.resultCandidates as Record<string, unknown>)).toHaveLength(1);
    expect(JSON.stringify(projects.snapshot('project', owner))).not.toContain(jwt);
    expect(await readdir(path.join(config.dataDir, 'sessions'))).toEqual([]);
    const credentialBefore = channels.row(managed.id)!.encrypted;
    const headers = { 'x-api-key': config.apiKey! };
    for (const url of ['/v1/jobs', `/v1/jobs/${legacy.jobs.list()[0]!.id}`, '/v1/sessions']) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('private-isolated-prompt');
      expect(response.body).not.toContain(jwt);
    }
    expect((await app.inject({ method: 'PUT', url: `/v1/sessions/${managed.id}/cookies`, headers,
      payload: { adapterId: new MioraAdapter().id, cookies: channels.session(managed.id)!.cookies } })).statusCode).toBe(404);
    expect(channels.row(managed.id)!.encrypted).toBe(credentialBefore);
    expect(externalFetch).not.toHaveBeenCalled();
  } finally {
    bridge?.close();
    await app?.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.assign(config, originalConfig);
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
