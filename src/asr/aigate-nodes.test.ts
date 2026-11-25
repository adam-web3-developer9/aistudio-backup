import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { AigateAsrNodes } from './aigate-nodes.js';

it('starts a stopped AIGate worker on demand, resolves its official port and shuts it down once idle', async () => {
  const db = new Database(':memory:');
  try {
    let now = 100_000;
    let status = '22';
    let ready = false;
    let opens = 0;
    let starts = 0;
    let closes = 0;
    const id = '12345';
    const remote = { host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' };
    const platform = {
      getInstance: async () => ({ id, status, services: [{ host: 'asr.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] }),
      openInstance: async () => { opens++; },
      closeInstance: async () => { closes++; },
      getSshConnection: async () => remote,
    };
    const boot = async (connection: typeof remote, verify: (fingerprint: string) => boolean) => {
      expect(connection).toEqual(remote);
      expect(verify('a'.repeat(64))).toBe(true);
      expect(verify('b'.repeat(64))).toBe(false);
      starts++;
    };
    const health = async (endpoint: string) => {
      expect(endpoint).toBe('https://asr.waas.aigate.cc');
      return ready;
    };
    let nodes = new AigateAsrNodes(db, platform, boot, () => now);
    await nodes.idle(id, () => true);
    now += 60_000;
    await nodes.idle(id, () => true);
    expect(opens).toBe(0);
    await nodes.ready(id, health);
    nodes = new AigateAsrNodes(db, platform, boot, () => now);
    await nodes.ready(id, health);
    expect(opens).toBe(1);
    now += 5_000;
    status = '2';
    await nodes.ready(id, health);
    await nodes.ready(id, health);
    expect(starts).toBe(1);
    ready = true;
    expect(await nodes.ready(id, health)).toBe('https://asr.waas.aigate.cc');
    await nodes.idle(id, () => true);
    now += 60_000;
    await nodes.idle(id, () => false);
    expect(closes).toBe(0);
    await nodes.idle(id, () => true);
    await nodes.idle(id, () => true);
    expect(closes).toBe(1);
    await nodes.ready(id, health);
    expect(opens).toBe(1);
  } finally { db.close(); }
});
