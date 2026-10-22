import { createHash } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AigateClient } from './aigate-client.js';
import { ComfyClient } from './comfy-client.js';
import { loadComfyConfiguration, type ComfyPoolConfiguration } from './configuration.js';
import { ComfyResultStore } from './result-store.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { validateProfile } from './workflow.js';
import type { ComfyEventSink } from './events.js';
import { TosResultStorage } from './tos-result-storage.js';
import { SshGpuResultExporter } from './ssh-result-exporter.js';

export interface ComfyRuntimeOptions {
  configuration: ComfyPoolConfiguration; token: string; fetch?: typeof fetch;
  archiveSecrets?: { accessKeyId: string; accessKeySecret: string };
}
export async function comfyOptionsFromEnv(environment = process.env): Promise<ComfyRuntimeOptions | undefined> {
  if (!environment.SYSTEM_COMFYUI_CONFIG) return;
  if (!environment.AIGATE_ACCESS_TOKEN) throw new Error('AIGATE_ACCESS_TOKEN is required when the ComfyUI pool is enabled');
  const configuration = await loadComfyConfiguration(environment.SYSTEM_COMFYUI_CONFIG, environment);
  const archiveSecrets = configuration.resultArchive ? {
    accessKeyId: environment.COMFY_TOS_ACCESS_KEY_ID ?? '', accessKeySecret: environment.COMFY_TOS_ACCESS_KEY_SECRET ?? '',
  } : undefined;
  if (archiveSecrets && (!archiveSecrets.accessKeyId.trim() || !archiveSecrets.accessKeySecret.trim())) {
    throw new Error('ComfyUI result archive credentials must be configured');
  }
  return { configuration, token: environment.AIGATE_ACCESS_TOKEN, ...(archiveSecrets ? { archiveSecrets } : {}) };
}
export function createComfyService(options: ComfyRuntimeOptions & {
  db: Database.Database; dataDirectory: string; apiKey: string;
  assets: ComfyServiceOptions['assets']; ownsAsset: ComfyServiceOptions['ownsAsset'];
  eventSink?: ComfyEventSink;
}): ComfyService {
  for (const profile of options.configuration.workflows) validateProfile(profile);
  const store = new ComfyStore(options.db, options.eventSink);
  const platform = new AigateClient({ token: options.token, fetch: options.fetch, capacityErrorCodes: options.configuration.capacityErrorCodes });
  const archive = options.configuration.resultArchive;
  if (archive && !options.archiveSecrets) throw new Error('ComfyUI result archive credentials are missing');
  const resultArchive = archive && options.archiveSecrets ? {
    keyPrefix: archive.keyPrefix,
    storageIdentity: createHash('sha256').update(JSON.stringify([archive.bucket, archive.region, archive.endpoint, archive.keyPrefix])).digest('hex'),
    storage: new TosResultStorage({ bucket: archive.bucket, region: archive.region, endpoint: archive.endpoint,
      accessKeyId: options.archiveSecrets.accessKeyId, accessKeySecret: options.archiveSecrets.accessKeySecret }),
    exporter: (id: string) => {
      const instance = options.configuration.instances.find(instance => instance.id === id);
      if (!instance) throw new Error('Archive instance is unavailable');
      return new SshGpuResultExporter({ connection: () => platform.getSshConnection(id),
        verifyHostKey: fingerprint => store.verifySshHostKey(id, fingerprint) });
    },
  } : undefined;
  const clients = new Map(options.configuration.instances.map(instance => [instance.id,
    new ComfyClient({ baseUrl: instance.baseUrl, headers: instance.headers, fetch: options.fetch, allowedGpuModels: instance.gpuModel ? [instance.gpuModel] : ['5090', '4090'] })]));
  return new ComfyService({
    store, configuration: options.configuration, platform,
    client: instance => {
      let client = clients.get(instance.id);
      if (!client) {
        client = new ComfyClient({ baseUrl: instance.baseUrl, headers: instance.headers, fetch: options.fetch,
          allowedGpuModels: instance.gpuModel ? [instance.gpuModel] : ['5090', '4090'] });
        clients.set(instance.id, client);
      }
      return client;
    }, assets: options.assets, ownsAsset: options.ownsAsset,
    owner: createHash('sha256').update(options.apiKey).digest('hex'),
    results: new ComfyResultStore(path.join(options.dataDirectory, 'comfy-results')),
    resultArchive,
  });
}
