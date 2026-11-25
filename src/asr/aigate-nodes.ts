import type Database from 'better-sqlite3';
import { Client } from 'ssh2';
import type { AigateClient, AigateInstance, AigateSshConnection } from '../comfyui/aigate-client.js';

export type AsrAigatePlatform = Pick<AigateClient, 'getInstance' | 'openInstance' | 'closeInstance' | 'releaseInstance' | 'getSshConnection'>;
type NodeState = {
  power_request: 'open' | 'close' | 'release' | null; power_requested_at: number | null;
  ssh_started_at: number | null; fingerprint: string | null;
};
const reconcileMs = 60_000;
const observeMs = 2_000;
const stopped = new Set(['22', '26']);

function asrEndpoint(metadata: AigateInstance) {
  const services = metadata.services.filter(service =>
    service.port === 18080 && service.httpType === '1' && /^https?$/i.test(service.protocol ?? ''));
  if (services.length !== 1) return;
  const host = services[0]!.host;
  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.waas.aigate.cc') || url.port
    || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid AIGate ASR service URL');
  }
  return url.origin;
}

// AIGate application images may use docker-init instead of systemd. Using one
// fixed command and a process-held lock makes replay safe after an SSH timeout.
const bootstrap = 'if test -d /run/systemd/system; then systemctl start --no-block qwen-asr.service; '
  + 'else umask 077; cd /home/waas/qwen-asr && test -r worker.env && '
  + '(nohup flock -n worker.lock /opt/qwen-asr/run.sh </dev/null >>worker.log 2>&1 &); fi';

export type AsrWorkerBootstrap = (connection: AigateSshConnection, verify: (fingerprint: string) => boolean) => Promise<void>;
const startWorker: AsrWorkerBootstrap = (connection, verify) => new Promise((resolve, reject) => {
  const ssh = new Client();
  const error = new Error('AIGate ASR SSH startup failed');
  let settled = false;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    ssh.end();
    if (success) resolve();
    else reject(error);
  };
  const timeout = setTimeout(() => finish(false), 20_000);
  ssh.on('error', () => finish(false)).once('close', () => finish(false)).once('ready', () => {
    ssh.exec(bootstrap, (failure, stream) => {
      if (failure) { finish(false); return; }
      stream.on('error', () => finish(false));
      stream.resume();
      stream.stderr.resume();
      stream.once('close', (code: number) => finish(code === 0));
    });
  });
  ssh.connect({ ...connection, readyTimeout: 15_000, hostHash: 'sha256', authHandler: ['password'],
    hostVerifier: (fingerprint: string) => { try { return verify(fingerprint); } catch { return false; } } });
});

export class AigateAsrNodes {
  private readonly observations = new Map<string, { metadata: AigateInstance; at: number }>();
  constructor(private readonly db: Database.Database, private readonly platform: AsrAigatePlatform,
      private readonly dispatch: AsrWorkerBootstrap = startWorker, private readonly clock = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS aigate_asr_nodes (
      id TEXT PRIMARY KEY, power_request TEXT, power_requested_at INTEGER,
      ssh_started_at INTEGER, idle_since INTEGER, fingerprint TEXT
    )`);
  }

  async ready(id: string, health: (endpoint: string) => Promise<boolean>) {
    const status = await this.observe(id);
    const state = this.node(id);
    const now = this.clock();
    const stateCode = status.operationStatus ?? status.status;
    if (state.power_request === 'release') {
      if (stopped.has(stateCode)) await this.requestIdleAction(id, 'release');
      return;
    }
    if (stopped.has(stateCode)) {
      const claimed = this.db.prepare(`UPDATE aigate_asr_nodes SET power_request='open',power_requested_at=?,ssh_started_at=NULL
        WHERE id=? AND (power_request IS NOT 'open' OR power_requested_at <= ?)`).run(now, id, now - reconcileMs);
      if (!claimed.changes) return;
      this.observations.delete(id);
      await this.platform.openInstance(id);
      return;
    }
    if (stateCode !== '2') return;
    if (state.power_request === 'close' && now - state.power_requested_at! < reconcileMs) return;
    if (state.power_request) this.clearPower(id);
    const endpoint = asrEndpoint(status);
    if (!endpoint) return;
    if (await health(endpoint)) return endpoint;
    if (state.ssh_started_at !== null && now - state.ssh_started_at < reconcileMs) return;
    const claimed = this.db.prepare(`UPDATE aigate_asr_nodes SET ssh_started_at=? WHERE id=?
      AND (ssh_started_at IS NULL OR ssh_started_at <= ?)`).run(now, id, now - reconcileMs);
    if (!claimed.changes) return;
    const connection = await this.platform.getSshConnection(id);
    await this.dispatch(connection, fingerprint => this.verifyHost(id, fingerprint));
  }

  async released(id: string) {
    const metadata = await this.observe(id);
    return (metadata.operationStatus ?? metadata.status) === '4';
  }

  async idle(id: string, mayStop: () => boolean, release = false) {
    const metadata = await this.observe(id);
    if (!mayStop()) return;
    const state = this.node(id);
    const stateCode = metadata.operationStatus ?? metadata.status;
    if (state.power_request === 'open' && this.clock() - state.power_requested_at! < reconcileMs) return;
    if (stopped.has(stateCode)) {
      if (release) await this.requestIdleAction(id, 'release');
      else if (state.power_request || state.ssh_started_at !== null) this.clearPower(id, true);
      return;
    }
    if (stateCode === '2' && state.power_request !== 'release') await this.requestIdleAction(id, 'close');
  }

  private async requestIdleAction(id: string, action: 'close' | 'release') {
    const now = this.clock();
    const claimed = this.db.prepare(`UPDATE aigate_asr_nodes SET power_request=?, power_requested_at=?
      WHERE id=? AND (power_request IS NOT ? OR power_requested_at <= ?)`).run(action, now, id, action, now - reconcileMs);
    if (!claimed.changes) return;
    this.observations.delete(id);
    if (action === 'release') await this.platform.releaseInstance(id);
    else await this.platform.closeInstance(id);
  }

  private clearPower(id: string, stopped = false) {
    this.db.prepare(`UPDATE aigate_asr_nodes SET power_request=NULL,power_requested_at=NULL${stopped ? ',ssh_started_at=NULL' : ''} WHERE id=?`).run(id);
  }

  private async observe(id: string) {
    const observation = this.observations.get(id);
    if (observation && this.clock() - observation.at < observeMs) return observation.metadata;
    const metadata = await this.platform.getInstance(id);
    if (metadata.id !== id) throw new Error('AIGate ASR instance ID mismatch');
    this.observations.set(id, { metadata, at: this.clock() });
    return metadata;
  }

  private node(id: string) {
    const get = this.db.prepare('SELECT * FROM aigate_asr_nodes WHERE id=?');
    const current = get.get(id) as NodeState | undefined;
    if (current) return current;
    this.db.prepare('INSERT OR IGNORE INTO aigate_asr_nodes(id) VALUES(?)').run(id);
    return get.get(id) as NodeState;
  }

  private verifyHost(id: string, fingerprint: string) {
    if (!/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
    const normalized = fingerprint.toLowerCase();
    this.db.prepare('UPDATE aigate_asr_nodes SET fingerprint=? WHERE id=? AND fingerprint IS NULL').run(normalized, id);
    return this.node(id).fingerprint === normalized;
  }
}
