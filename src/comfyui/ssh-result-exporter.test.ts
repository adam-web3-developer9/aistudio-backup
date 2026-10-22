import { EventEmitter } from 'node:events';
import type { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { afterEach, expect, it, vi } from 'vitest';
import { SshGpuResultExporter } from './ssh-result-exporter.js';
import type { ComfyJob } from './store.js';

const job = { id: 'test-job', prompt_id: 'test-prompt' } as ComfyJob;
const output = { filename: 'result.mp4', subfolder: '', type: 'output' };
const file = { size: 4096, sha256: 'a'.repeat(64), md5: Buffer.alloc(16, 1).toString('base64') };
const inspected = { python: '/opt/comfy/python3', outputRoot: '/output', port: 8188, pid: 123 };
const password = 'private-ssh-password';
const target = { url: 'https://bucket.tos-cn-beijing.volces.com/result.mp4?signature=private', headers: {} };
type Response = { stdout?: Buffer | string; stderr?: string; exit?: number; hold?: boolean; error?: boolean };

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  close = vi.fn();
  destroy = vi.fn();
  end = vi.fn((body: string) => {
    this.request = JSON.parse(body);
    queueMicrotask(() => {
      if (this.response.hold) return;
      if (this.response.error) { this.emit('error', new Error(password + target.url)); return; }
      if (this.response.stdout !== undefined) this.emit('data', this.response.stdout);
      if (this.response.stderr !== undefined) this.stderr.emit('data', this.response.stderr);
      this.emit('exit', this.response.exit ?? 0);
      this.emit('close', this.response.exit ?? 0);
    });
  });
  request?: Record<string, unknown>;
  constructor(readonly response: Response) { super(); }
}

class Connection extends EventEmitter {
  settings?: ConnectConfig;
  commands: string[] = [];
  channels: Channel[] = [];
  end = vi.fn();
  destroy = vi.fn();
  connect = vi.fn((settings: ConnectConfig) => {
    this.settings = settings;
    const verifier = settings.hostVerifier as (fingerprint: string) => boolean;
    queueMicrotask(() => {
      if (verifier('a'.repeat(64))) this.emit('ready');
      else this.emit('error', new Error(password));
    });
    return this;
  });
  exec = vi.fn((command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
    this.commands.push(command);
    const channel = new Channel(this.responses.shift() ?? { stdout: JSON.stringify(file) });
    this.channels.push(channel);
    callback(undefined, channel as unknown as ClientChannel);
    return this;
  });
  constructor(readonly responses: Response[]) { super(); }
}

function fixture(responses: Response[] = [], pin: () => boolean = () => true) {
  const connection = new Connection([{ stdout: JSON.stringify(inspected) }, ...responses]);
  const credentials = vi.fn().mockResolvedValue({ host: 'native-ssh.east1.waas.aigate.cc', port: 30022, username: 'root', password });
  const factory = vi.fn(() => connection as unknown as Client);
  const exporter = new SshGpuResultExporter({ connection: credentials, verifyHostKey: pin,
    clientFactory: factory, runnerSource: 'trusted runner', exporterSource: 'trusted exporter' });
  return { exporter, connection, credentials, factory };
}

afterEach(() => vi.useRealTimers());

it('uses password auth and pinned host hashes, sends sources and target only through stdin, then closes the connection', async () => {
  const context = fixture();
  expect(await context.exporter.upload(job, output, file, target, new AbortController().signal)).toEqual(file);
  expect(context.connection.settings).toMatchObject({ hostHash: 'sha256', readyTimeout: 20_000,
    authHandler: ['password'], username: 'root', password });
  expect(context.credentials).toHaveBeenCalledOnce();
  expect(context.connection.commands[0]).toMatch(/^python3 -B -c /);
  expect(context.connection.commands[1]).toMatch(/^\/opt\/comfy\/python3 -B -c /);
  expect(context.connection.commands.join(' ')).not.toMatch(/private|test-job|test-prompt|trusted runner/);
  expect(context.connection.channels[0]?.request).toEqual({ runnerSource: 'trusted runner', operation: 'inspect' });
  expect(context.connection.channels[1]?.request).toMatchObject({ operation: 'upload', runtime: inspected,
    exporterSource: 'trusted exporter', payload: { jobId: job.id, promptId: job.prompt_id, output, file, target } });
  expect(context.connection.end).toHaveBeenCalledOnce();
  expect(context.connection.destroy).toHaveBeenCalledOnce();
});

it('rejects changed host keys before executing any remote command', async () => {
  const context = fixture([], () => false);
  await expect(context.exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject({ code: 'COMFY_ARCHIVE_GPU_UNAVAILABLE' });
  expect(context.connection.commands).toEqual([]);
  expect(context.connection.destroy).toHaveBeenCalledOnce();
});

it.each([
  { stdout: '{invalid' }, { stdout: JSON.stringify({ error: password + target.url }) },
  { stdout: Buffer.from([255]) }, { stdout: 'a'.repeat(65_537) },
  { stderr: 'a'.repeat(8193), stdout: JSON.stringify(file) },
  { stdout: JSON.stringify(file), exit: 1 }, { error: true },
  { stdout: JSON.stringify({ ...file, size: 0 }) },
  { stdout: JSON.stringify({ ...file, md5: 'invalid' }) },
  { stdout: JSON.stringify({ ...file, sha256: 'z'.repeat(64) }) },
])('rejects malformed or failed remote results without leaking private values %#', async response => {
  const context = fixture([response]);
  try {
    await context.exporter.describe(job, output, new AbortController().signal);
    throw new Error('Expected export rejection');
  } catch (error) {
    expect(String(error)).not.toContain(password);
    expect(String(error)).not.toContain(target.url);
    expect(error).toHaveProperty('code');
  }
  expect(context.connection.destroy).toHaveBeenCalledOnce();
});

it.each(['/opt/python;exit', '/opt/../python', 'python3', '/opt/python\n'])('rejects an unsafe discovered interpreter %s', async python => {
  const context = fixture();
  context.connection.responses[0] = { stdout: JSON.stringify({ ...inspected, python }) };
  await expect(context.exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject({ code: 'COMFY_ARCHIVE_GPU_INVALID' });
  expect(context.connection.commands).toHaveLength(1);
});

it('rejects an upload receipt whose digest differs from the described file', async () => {
  const context = fixture([{ stdout: JSON.stringify({ ...file, sha256: 'b'.repeat(64) }) }]);
  await expect(context.exporter.upload(job, output, file, target, new AbortController().signal)).rejects.toMatchObject({ code: 'COMFY_ARCHIVE_GPU_INVALID' });
});

it('aborts an active command and closes its channel and transport', async () => {
  const context = fixture([{ hold: true }]);
  const controller = new AbortController();
  const promise = context.exporter.describe(job, output, controller.signal);
  const rejected = expect(promise).rejects.toMatchObject({ code: 'COMFY_ARCHIVE_GPU_UNAVAILABLE' });
  await vi.waitFor(() => expect(context.connection.channels).toHaveLength(2));
  controller.abort();
  await rejected;
  expect(context.connection.channels[1]?.close).toHaveBeenCalledOnce();
  expect(context.connection.destroy).toHaveBeenCalledOnce();
});

it('times out a stalled command without leaving an active transport', async () => {
  vi.useFakeTimers();
  const context = fixture([{ hold: true }]);
  const promise = context.exporter.describe(job, output, new AbortController().signal);
  const rejected = expect(promise).rejects.toMatchObject({ code: 'COMFY_ARCHIVE_GPU_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(context.connection.destroy).toHaveBeenCalledOnce();
});

it('does not create an SSH connection when cancellation happens during metadata lookup', async () => {
  const context = fixture();
  let resolve!: (value: unknown) => void;
  context.credentials.mockImplementation(() => new Promise(value => { resolve = value; }));
  const controller = new AbortController();
  const pending = context.exporter.describe(job, output, controller.signal);
  const rejected = expect(pending).rejects.toHaveProperty('code', 'COMFY_ARCHIVE_GPU_UNAVAILABLE');
  await vi.waitFor(() => expect(context.credentials).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  resolve({ host: 'native-ssh.east1.waas.aigate.cc', port: 30022, username: 'root', password });
  await Promise.resolve();
  expect(context.factory).not.toHaveBeenCalled();
});
