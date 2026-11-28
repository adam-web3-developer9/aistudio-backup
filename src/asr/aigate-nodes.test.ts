import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { AigateAsrNodes, defaultAsrIdleGraceMs } from './aigate-nodes.js';

it.each([false, true])('starts on demand, keeps warm during idle grace, then shuts down and releases only template workers (%s)', async release => {
  const db = new Database(':memory:');
  try {
    let now = 100_000;
    let status = '22';
    let ready = false;
    let gets = 0;
    let opens = 0;
    let starts = 0;
    let closes = 0;
    let releases = 0;
    let idlePolicies = 0;
    const id = '12345';
    const remote = { host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' };
    const platform = {
      getInstance: async () => {
        gets++;
        return { id, status, services: [{ host: 'asr.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] };
      },
      openInstance: async () => { opens++; },
      closeInstance: async () => { closes++; },
      releaseInstance: async () => { releases++; },
      getSshConnection: async () => remote,
      setGpuIdleShutdown: async () => { idlePolicies++; },
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
    expect(idlePolicies).toBe(1);
    ready = true;
    expect(await nodes.ready(id, health)).toBe('https://asr.waas.aigate.cc');
    expect(nodes.isWarm(id)).toBe(true);
    await nodes.idle(id, () => false, release);
    expect(closes).toBe(0);
    // First idle tick records idle_since and waits for grace period.
    await nodes.idle(id, () => true, release);
    expect(closes).toBe(0);
    expect(nodes.isWarm(id)).toBe(true);
    const getsAtIdleStart = gets;
    now += 10_000;
    await nodes.idle(id, () => true, release);
    expect(closes).toBe(0);
    expect(gets).toBe(getsAtIdleStart);
    // Returning demand cancels the idle grace window without stopping the GPU.
    expect(await nodes.ready(id, health)).toBe('https://asr.waas.aigate.cc');
    await nodes.idle(id, () => true, release);
    expect(closes).toBe(0);
    now += defaultAsrIdleGraceMs;
    await nodes.idle(id, () => true, release);
    await nodes.idle(id, () => true, release);
    expect(closes).toBe(1);
    await nodes.ready(id, health);
    expect(opens).toBe(1);
    expect(releases).toBe(0);
    status = '22';
    nodes = new AigateAsrNodes(db, platform, boot, () => now);
    await nodes.idle(id, () => true, release);
    expect(releases).toBe(release ? 1 : 0);
    if (release) {
      nodes = new AigateAsrNodes(db, platform, boot, () => now);
      expect(await nodes.ready(id, health)).toBeUndefined();
      expect(opens).toBe(1);
      expect(releases).toBe(1);
      now += 60_000;
      await nodes.ready(id, health);
      expect(releases).toBe(2);
      expect(opens).toBe(1);
    }
  } finally { db.close(); }
});

it('retries transient SSH startup failures after 5 seconds instead of locking out for 60 seconds', async () => {
  const db = new Database(':memory:');
  try {
    let now = 200_000;
    let attempts = 0;
    const id = '99999';
    const remote = { host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' };
    const platform = {
      getInstance: async () => ({ id, status: '2', services: [{ host: 'asr.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] }),
      openInstance: async () => {},
      closeInstance: async () => {},
      releaseInstance: async () => {},
      getSshConnection: async () => remote,
    };
    const boot = async () => {
      attempts++;
      if (attempts === 1) throw new Error('sshd not ready');
    };
    const nodes = new AigateAsrNodes(db, platform, boot, () => now);
    await expect(nodes.ready(id, async () => false)).rejects.toThrow('sshd not ready');
    expect(attempts).toBe(1);
    now += 4_000;
    await nodes.ready(id, async () => false);
    expect(attempts).toBe(1);
    now += 1_000;
    await nodes.ready(id, async () => false);
    expect(attempts).toBe(2);
  } finally { db.close(); }
});
