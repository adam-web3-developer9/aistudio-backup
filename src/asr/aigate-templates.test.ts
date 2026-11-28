import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import type { AigateCreateRequest } from '../comfyui/aigate-client.js';
import { AigateAsrNodes } from './aigate-nodes.js';
import { AigateAsrTemplates, type AsrAigateTemplate } from './aigate-templates.js';

it('tries configured SKUs after a definite shortage and reconciles an uncertain rental by the same name', async () => {
  const db = new Database(':memory:');
  try {
    let now = 100_000;
    const requests: AigateCreateRequest[] = [];
    let found = false;
    let status = '4';
    const template: AsrAigateTemplate = {
      id: 'east2', areaName: '华东二区', imageId: '17', skuNames: ['preferred', 'fallback', 'spare'], instanceId: '11',
    };
    const platform = {
      getInstance: async (id: string) => ({ id, status, services: [] }),
      openInstance: async () => {}, closeInstance: async () => {}, releaseInstance: async () => {},
      getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
      createInstance: async (input: AigateCreateRequest) => {
        requests.push(input);
        if (input.skuName === 'preferred') {
          throw Object.assign(new Error('no capacity'), { code: 'CAPACITY_UNAVAILABLE', uncertain: false });
        }
        throw new Error('lost purchase reply');
      },
      findInstancesByName: async (name: string) => {
        expect(name).toBe(requests[0]?.instanceName);
        return { records: found ? [{ id: '12', areaName: template.areaName, imageId: template.imageId,
          imageType: '3', status: '2', services: [] }] : [], complete: true, pagesScanned: 1 };
      },
    };
    const power = new AigateAsrNodes(db, platform, undefined, () => now);
    let slots = new AigateAsrTemplates(db, power, platform, [template], () => now);
    expect(await slots.resolve(template, false, false)).toBe('11');
    expect(await slots.resolve(template, true, false)).toBe('11');
    expect(requests).toHaveLength(0);
    await expect(slots.resolve(template, true, true)).rejects.toThrow('lost purchase reply');
    expect(requests.map(request => request.skuName)).toEqual(['preferred', 'fallback']);
    expect(requests[0]?.instanceName).toMatch(/^qasr-[a-f0-9]{15}$/);
    expect(requests[1]?.instanceName).toBe(requests[0]?.instanceName);
    now += 30_000;
    slots = new AigateAsrTemplates(db, power, platform, [template], () => now);
    expect(await slots.resolve(template, true, true)).toBeUndefined();
    now += 30_000;
    status = '2';
    found = true;
    expect(await slots.resolve(template, true, true)).toBe('12');
    expect(await slots.resolve(template, true, true)).toBe('12');
    expect(requests).toHaveLength(2);
  } finally { db.close(); }
});

it('skips delisted SKUs on confirmed business rejection without skipping insufficient balance', async () => {
  const db = new Database(':memory:');
  try {
    const tried: string[] = [];
    const template: AsrAigateTemplate = {
      id: 'east2', areaName: '华东二区', imageId: '17', skuNames: ['A10G-24GB', 'delisted-sku', '4090-24GB'],
    };
    let balanceShort = false;
    const platform = {
      getInstance: async (id: string) => ({ id, status: '4', services: [] }),
      openInstance: async () => {}, closeInstance: async () => {}, releaseInstance: async () => {},
      getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
      createInstance: async (input: AigateCreateRequest) => {
        tried.push(input.skuName!);
        if (balanceShort) {
          throw Object.assign(new Error('low balance'), { code: 'BUSINESS_REJECTED', uncertain: false, reason: 'INSUFFICIENT_BALANCE' });
        }
        if (input.skuName === 'A10G-24GB') {
          throw Object.assign(new Error('no capacity'), { code: 'CAPACITY_UNAVAILABLE', uncertain: false });
        }
        if (input.skuName === 'delisted-sku') {
          throw Object.assign(new Error('sku invalid'), { code: 'BUSINESS_REJECTED', uncertain: false, reason: 'INSTANCE_START_REJECTED' });
        }
        return '88';
      },
      findInstancesByName: async () => ({ records: [], complete: true, pagesScanned: 1 }),
    };
    const power = new AigateAsrNodes(db, platform);
    const slots = new AigateAsrTemplates(db, power, platform, [template]);
    expect(await slots.resolve(template, true, true)).toBe('88');
    expect(tried).toEqual(['A10G-24GB', 'delisted-sku', '4090-24GB']);

    tried.length = 0;
    balanceShort = true;
    const second: AsrAigateTemplate = {
      id: 'east1', areaName: '华东一区', imageId: '18', skuNames: ['A10G-24GB', '5090-32GB'],
    };
    const slots2 = new AigateAsrTemplates(db, power, platform, [second]);
    await expect(slots2.resolve(second, true, true)).rejects.toMatchObject({ reason: 'INSUFFICIENT_BALANCE' });
    expect(tried).toEqual(['A10G-24GB']);
  } finally { db.close(); }
});
