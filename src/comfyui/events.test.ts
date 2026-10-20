import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyEventLog, type ComfyEventInput, type ComfyEventQuery } from './events.js';

let directory: string;
let database: Database.Database;
let log: ComfyEventLog;
const instanceId = '1096749550260588544';
const secret = 'Bearer test-private-credential';

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'comfy-events-test-'));
  database = new Database(path.join(directory, 'events.sqlite'));
  log = new ComfyEventLog(database);
});

afterEach(() => {
  vi.useRealTimers();
  if (database?.open) database.close();
  if (!directory) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
  rmSync(directory, { recursive: true, force: true });
});

describe('ComfyEventLog', () => {
  it('synchronously persists ISO timestamps, monotonic sequences and whitelisted details across restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T08:00:00.000Z'));
    const first = log.record({ type: 'job.accepted', jobId: 'job-a', stage: 'queued' });
    expect(first).toEqual({ type: 'job.accepted', jobId: 'job-a', stage: 'queued', sequence: 1, time: '2026-10-20T08:00:00.000Z' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfy_events').get()).toEqual({ count: 1 });
    const second = log.record({ type: 'job.updated', jobId: 'job-a', instanceId, stage: 'running', code: 'COMFY_RUNNING',
      details: { fromStage: 'submitting', toStage: 'running', fromState: 'ready', toState: 'busy',
        completed: 0, total: 20, areaName: '华东一区', gpuModel: '5090', upstreamCode: 'PROVIDER_CODE:1.0',
        httpStatus: 400, nodeId: '29:0', errorType: 'value_not_in_list' } });
    database.close();
    database = new Database(path.join(directory, 'events.sqlite'));
    log = new ComfyEventLog(database);
    expect(log.list({ jobId: 'job-a' })).toEqual([first, second]);
    expect(log.record({ type: 'instance.updated', instanceId, details: { toState: 'ready' } }).sequence).toBe(3);
  });

  it('paginates ascending by sequence even when time moves backwards', () => {
    vi.useFakeTimers();
    const saved = [];
    for (let index = 0; index < 5; index++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 20, 8, 5 - index)));
      saved.push(log.record({ type: 'job.updated', jobId: 'job-a', details: { completed: index, total: 5 } }));
      log.record({ type: 'job.updated', jobId: 'job-b' });
    }
    const first = log.list({ jobId: 'job-a', limit: 2 });
    const second = log.list({ jobId: 'job-a', after: first[1]!.sequence, limit: 2 });
    const third = log.list({ jobId: 'job-a', after: second[1]!.sequence, limit: 2 });
    expect([...first, ...second, ...third]).toEqual(saved);
    expect(log.list({ jobId: 'job-a', after: third[0]!.sequence })).toEqual([]);
    expect(log.recent('job-a', 2)).toEqual(saved.slice(-2));
    expect(log.recent('job-a')).toEqual(saved);
    expect(log.recent('unknown')).toEqual([]);
  });

  it('isolates exact job/instance scopes and intersects both rather than OR-ing them', () => {
    const first = log.record({ type: 'job.accepted', jobId: 'job-a', instanceId });
    const second = log.record({ type: 'job.updated', jobId: 'job-b', instanceId: '2' });
    const third = log.record({ type: 'instance.updated', instanceId });
    log.record({ type: 'job.updated', jobId: 'job-a', instanceId: '2' });
    expect(log.list({ jobId: 'job-b' })).toEqual([second]);
    expect(log.list({ instanceId })).toEqual([first, third]);
    expect(log.list({ jobId: 'job-a', instanceId })).toEqual([first]);
    expect(log.list({ jobId: 'job-b', instanceId })).toEqual([]);
    expect(log.list({ jobId: 'missing' })).toEqual([]);
    expect(log.list({ instanceId: 'missing' })).toEqual([]);
    expect(log.recent('job-b')).toEqual([second]);
  });

  it.each([{}, { after: 0 }, { jobId: '' }, { instanceId: '' }, { jobId: null },
    { jobId: 'job-a', after: -1 }, { jobId: 'job-a', after: 1.5 }, { jobId: 'job-a', after: Infinity },
    { jobId: 'job-a', after: Number.MAX_SAFE_INTEGER + 1 }, { jobId: 'job-a', after: '1' },
    { jobId: 'job-a', limit: 0 }, { jobId: 'job-a', limit: 1001 }, { jobId: 'job-a', limit: 1.5 },
    { jobId: 'job-a', limit: '1' }, { jobId: 'job-a', owner: secret }, { jobId: "job-a' OR 1=1 --" }, null])(
    'rejects unscoped, injected or invalid queries at runtime %#', value => {
      expect(() => log.list(value as ComfyEventQuery)).toThrow('Invalid Comfy event');
    }
  );

  it.each([0, -1, 1001, NaN, Infinity, '2'])('validates recent limits at runtime %#', limit => {
    expect(() => log.recent('job-a', limit as number)).toThrow('Invalid Comfy event');
  });

  it.each(['prompt', 'url', 'credentials', 'token', 'Authorization', 'input', 'owner', 'sequence', 'time', 'toJSON'])(
    'rejects unregistered top-level %s without storing or exposing its value', field => {
      const sink = vi.fn();
      log = new ComfyEventLog(database, sink);
      const value = { type: 'job.accepted', jobId: 'job-a', [field]: secret };
      expect(() => log.record(value as ComfyEventInput)).toThrow('Invalid Comfy event');
      expect(log.list({ jobId: 'job-a' })).toEqual([]);
      expect(sink).not.toHaveBeenCalled();
      expect(JSON.stringify(database.prepare('SELECT * FROM comfy_events').all())).not.toContain(secret);
    }
  );

  it.each(['prompt', 'url', 'credentials', 'token', 'filename', 'providerMessage', 'msg', 'stack', 'path', 'body', '__proto__', 'toJSON'])(
    'rejects unregistered details field %s at runtime', field => {
      const value = { type: 'job.updated', jobId: 'job-a', details: JSON.parse(JSON.stringify({ [field]: secret })) };
      expect(() => log.record(value as ComfyEventInput)).toThrow('Invalid Comfy event');
      expect(log.list({ jobId: 'job-a' })).toEqual([]);
    }
  );

  it.each(['upstreamCode', 'nodeId', 'errorType'] as const)('persists only safe %s identifiers, including the length boundary', field => {
    const sink = vi.fn();
    log = new ComfyEventLog(database, sink);
    for (const value of ['1', 'Native.Node_Type:invalid-value', 'a'.repeat(100)]) {
      const saved = log.record({ type: 'job.updated', jobId: 'job-a', details: { [field]: value } });
      expect(saved.details).toEqual({ [field]: value });
      expect(log.recent('job-a', 1)).toEqual([saved]);
      expect(sink.mock.calls.at(-1)![0]).toEqual(saved);
    }
  });

  it.each(['upstreamCode', 'nodeId', 'errorType'] as const)('rejects unsafe %s values at runtime without writing or emitting them', field => {
    const sink = vi.fn();
    log = new ComfyEventLog(database, sink);
    for (const value of ['', 'a'.repeat(101), secret, 'https://secret.invalid', 'C:\\private\\file', '/private/file',
      '../private/file', 'bad\ncode', 'bad\r\ncode', 'private prompt', 'code?token=private', {}, [], 123, null]) {
      expect(() => log.record({ type: 'job.updated', jobId: 'job-a', details: { [field]: value } } as ComfyEventInput))
        .toThrow('Invalid Comfy event');
    }
    expect(log.list({ jobId: 'job-a' })).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it.each([100, 200, 400, 599])('accepts HTTP status %i', httpStatus => {
    const saved = log.record({ type: 'job.updated', jobId: 'job-a', details: { httpStatus } });
    expect(log.list({ jobId: 'job-a' })).toEqual([saved]);
    expect(saved.details).toEqual({ httpStatus });
  });

  it.each([99, 600, -1, 200.5, NaN, Infinity, '400', null, {}])('rejects invalid HTTP status %#', httpStatus => {
    expect(() => log.record({ type: 'job.updated', jobId: 'job-a', details: { httpStatus } } as ComfyEventInput))
      .toThrow('Invalid Comfy event');
    expect(log.list({ jobId: 'job-a' })).toEqual([]);
  });

  it.each([
    { type: 'job.prompt' }, { type: undefined }, { stage: 'arbitrary prompt' }, { code: secret }, { code: 'https://secret.invalid' },
    { jobId: 'https://secret.invalid' }, { instanceId: secret }, { details: { fromStage: secret } },
    { details: { toStage: 'https://secret.invalid' } }, { details: { fromState: 'other' } }, { details: { toState: secret } },
    { details: { completed: -1 } }, { details: { completed: NaN } }, { details: { completed: Infinity } },
    { details: { total: 1.5 } }, { details: { total: Number.MAX_SAFE_INTEGER + 1 } },
    { details: { total: '1' } }, { details: { areaName: 'a private prompt' } }, { details: { gpuModel: secret } },
    { details: [] }, { details: null }
  ])('does not permit sensitive free-form content or invalid values through whitelisted keys %#', override => {
    const value = { type: 'job.updated', jobId: 'job-a', ...override };
    const sink = vi.fn();
    log = new ComfyEventLog(database, sink);
    expect(() => log.record(value as ComfyEventInput)).toThrow('Invalid Comfy event');
    expect(sink).not.toHaveBeenCalled();
    expect(log.list({ jobId: 'job-a' })).toEqual([]);
  });

  it('rejects scope-free events, inherited fields, symbols and getters without invoking them', () => {
    expect(() => log.record({ type: 'job.accepted' })).toThrow('Invalid Comfy event');
    const inherited = Object.assign(Object.create({ token: secret }), { type: 'job.accepted', jobId: 'job-a' });
    expect(() => log.record(inherited)).toThrow('Invalid Comfy event');
    const symbol = { type: 'job.accepted', jobId: 'job-a', [Symbol('secret')]: secret };
    expect(() => log.record(symbol as ComfyEventInput)).toThrow('Invalid Comfy event');
    const getter = vi.fn(() => secret);
    const value = { type: 'job.accepted', jobId: 'job-a' };
    Object.defineProperty(value, 'code', { get: getter });
    expect(() => log.record(value as ComfyEventInput)).toThrow('Invalid Comfy event');
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not output unregistered details from a tampered persisted row', () => {
    log.record({ type: 'job.updated', jobId: 'job-a' });
    const other = log.record({ type: 'job.updated', jobId: 'job-b' });
    database.prepare('UPDATE comfy_events SET details=? WHERE job_id=?').run(JSON.stringify({ prompt: secret }), 'job-a');
    expect(() => log.list({ jobId: 'job-a' })).toThrow('Invalid Comfy event');
    expect(() => log.recent('job-a')).toThrow('Invalid Comfy event');
    expect(log.list({ jobId: 'job-b' })).toEqual([other]);
  });

  it('keeps persistence and caller data isolated from a throwing or mutating sink', () => {
    const value: ComfyEventInput = { type: 'instance.updated', instanceId, details: { fromState: 'starting', toState: 'ready' } };
    const sink = vi.fn(event => { event.details.toState = 'offline'; throw new Error(secret); });
    log = new ComfyEventLog(database, sink);
    const saved = log.record(value);
    expect(sink).toHaveBeenCalledTimes(1);
    value.details!.toState = 'busy';
    expect(saved.details!.toState).toBe('ready');
    expect(log.list({ instanceId })).toEqual([saved]);
    saved.details!.toState = 'closing';
    expect(log.list({ instanceId })[0]!.details!.toState).toBe('ready');
  });

  it('absorbs rejected async sinks without affecting SQL', async () => {
    log = new ComfyEventLog(database, async () => { throw new Error(secret); });
    const saved = log.record({ type: 'job.updated', jobId: 'job-a' });
    await Promise.resolve();
    expect(log.list({ jobId: 'job-a' })).toEqual([saved]);
  });

  it('does not call the sink when SQL fails and participates in caller transactions', () => {
    const sink = vi.fn();
    log = new ComfyEventLog(database, sink);
    expect(() => database.transaction(() => {
      log.record({ type: 'job.accepted', jobId: 'job-a' });
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(log.list({ jobId: 'job-a' })).toEqual([]);
    sink.mockClear();
    database.exec('DROP TABLE comfy_events');
    expect(() => log.record({ type: 'job.accepted', jobId: 'job-a' })).toThrow();
    expect(sink).not.toHaveBeenCalled();
  });
});
