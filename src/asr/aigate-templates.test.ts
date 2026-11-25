import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { AigateCreateRequest } from '../comfyui/aigate-client.js';
import { AigateAsrNodes } from './aigate-nodes.js';
import { AigateAsrTemplates, type AsrAigateTemplate } from './aigate-templates.js';

it('reconciles an uncertain rental by its frozen name without purchasing another node', async () => {
  const db = new Database(':memory:');
  try {
    let now = 100_000;
    let request: AigateCreateRequest | undefined;
    let found = false;
    let calls = 0;
    let status = '4';
    const template: AsrAigateTemplate = { id: 'east2', areaName: '华东二区', imageId: '17', skuName: '5090', instanceId: '11' };
    const platform = {
      getInstance: async (id: string) => ({ id, status, services: [] }),
      openInstance: async () => {}, closeInstance: async () => {},
      getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
      createInstance: async (input: AigateCreateRequest) => {
        request = input;
        calls++;
        throw new Error('lost purchase reply');
      },
      findInstancesByName: async (name: string) => {
        expect(name).toBe(request?.instanceName);
        return { records: found ? [{ id: '12', areaName: template.areaName, imageId: template.imageId,
          imageType: '3', status: '2', services: [] }] : [], complete: true, pagesScanned: 1 };
      },
    };
    const power = new AigateAsrNodes(db, platform, undefined, () => now);
    let slots = new AigateAsrTemplates(db, power, platform, [template], () => now);
    expect(await slots.resolve(template, false, false)).toBe('11');
    expect(await slots.resolve(template, true, false)).toBe('11');
    expect(calls).toBe(0);
    await expect(slots.resolve(template, true, true)).rejects.toThrow('lost purchase reply');
    expect(request?.instanceName).toMatch(/^qasr-[a-f0-9]{15}$/);
    now += 30_000;
    slots = new AigateAsrTemplates(db, power, platform, [template], () => now);
    expect(await slots.resolve(template, true, true)).toBeUndefined();
    now += 30_000;
    status = '2';
    found = true;
    expect(await slots.resolve(template, true, true)).toBe('12');
    expect(await slots.resolve(template, true, true)).toBe('12');
    expect(calls).toBe(1);
  } finally { db.close(); }
});
