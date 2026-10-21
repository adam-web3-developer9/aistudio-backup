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

export interface ComfyRuntimeOptions { configuration: ComfyPoolConfiguration; token: string; fetch?: typeof fetch }
export async function comfyOptionsFromEnv(environment = process.env): Promise<ComfyRuntimeOptions | undefined> {
  if (!environment.SYSTEM_COMFYUI_CONFIG) return;
  if (!environment.AIGATE_ACCESS_TOKEN) throw new Error('AIGATE_ACCESS_TOKEN is required when the ComfyUI pool is enabled');
  return { configuration: await loadComfyConfiguration(environment.SYSTEM_COMFYUI_CONFIG, environment), token: environment.AIGATE_ACCESS_TOKEN };
}
export function createComfyService(options: ComfyRuntimeOptions & {
  db: Database.Database; dataDirectory: string; apiKey: string;
  assets: ComfyServiceOptions['assets']; ownsAsset: ComfyServiceOptions['ownsAsset'];
  eventSink?: ComfyEventSink;
}): ComfyService {
  for (const profile of options.configuration.workflows) validateProfile(profile);
  const clients = new Map(options.configuration.instances.map(instance => [instance.id,
    new ComfyClient({ baseUrl: instance.baseUrl, headers: instance.headers, fetch: options.fetch, allowedGpuModels: instance.gpuModel ? [instance.gpuModel] : ['5090', '4090'] })]));
  return new ComfyService({
    store: new ComfyStore(options.db, options.eventSink), configuration: options.configuration,
    platform: new AigateClient({ token: options.token, fetch: options.fetch, capacityErrorCodes: options.configuration.capacityErrorCodes }),
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
  });
}
