import path from 'node:path';
import { createComfyService, type ComfyRuntimeOptions } from './comfyui/runtime.js';
import { comfyEventQuerySchema, comfyInputsSchema, comfyJobSchema } from './comfyui/routes.js';
import { validMediaSignature } from './system-media/routes.js';
import { randomUUID } from 'node:crypto';
import { ManagedSessionStore } from './system-channels/session-store.js';
import type { ChannelStore } from './system-channels/store.js';
import { ManagedAccountOperations, type ManagedArchiveReason, type ManagedAccountCreditReader } from './system-channels/account-operations.js';
import { systemLoggerOptions } from './system/security.js';
import { SystemError } from './system/types.js';
import { assertVideoGatewayConfiguration, assertVideoGatewayProxyConfiguration, assertVideoGatewayRequest, ManagedVideoGatewayRecords, gatewayJobIdPrefix, projectGatewayJob } from './system-channels/video-gateway.js';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { config } from './config.js';
import { AssetStore } from './stores/asset-store.js';
import { SessionStore } from './stores/session-store.js';
import { TokenFilePruner, TokenFileWatcher, type ParsedTokenFile } from './stores/token-file.js';
import { JobStore } from './stores/job-store.js';
import { BrowserPool } from './browser/browser-pool.js';
import { AdapterRegistry } from './adapters/adapter.js';
import { DemoAdapter } from './adapters/demo-adapter.js';
import { HailuoAdapter, hailuoJobBudgetMs } from './adapters/hailuo-adapter.js';
import { describeHailuoToken, hailuoTokenCookies, readTokenCookie, useHailuoProxy } from './adapters/hailuo-api.js';
import { DreamMakerAdapter, dreamMakerJobBudgetMs } from './adapters/dreammaker-adapter.js';
import { dreamMakerTokenCookies, readDreamMakerToken, useDreamMakerProxy } from './adapters/dreammaker-api.js';
import { HiggsfieldAdapter, higgsfieldJobBudgetMs } from './adapters/higgsfield-adapter.js';
import {
  higgsfieldMcpCookies,
  readHiggsfieldMcpTokens,
  useHiggsfieldMcpProxy
} from './adapters/higgsfield-mcp.js';
import { MioraAdapter, mioraEstimatedVideoCredits, mioraJobBudgetMs, mioraMinimumVideoCredits } from './adapters/miora-adapter.js';
import { mioraTokenCookies, prepareCosUpload, readMioraTokens, useMioraProxy, type MioraTokens } from './adapters/miora-api.js';
import { MioraClient } from './adapters/miora-client.js';
import { readLegacyMediaJson } from './system-media/resources.js';
import { ProjectError } from './projects/protocol.js';
import { MioraDiagnosticSink, mioraDiagnostic, withMioraDiagnostics } from './adapters/miora-diagnostics.js';
import { describeMioraTransferFailure, MioraCosTransferCoordinator, transferPublicMediaToMioraCos } from './adapters/miora-cos-transfer.js';
import {
  MioraCredentials,
  MioraAccountPruner,
  parseMioraAccounts,
  persistMioraRenewal,
  type ParsedMioraAccounts,
  type ResolvedMioraAccount
} from './jobs/miora-accounts.js';
import { archiveMioraExports, MioraImportWatcher } from './jobs/miora-import.js';
import { AccountPool, type AccountSnapshot } from './jobs/account-pool.js';
import { AccountBalanceReporter } from './jobs/account-balance-report.js';
import {
  DreamMakerCredentials,
  parseDreamMakerAccounts,
  type ParsedDreamMakerAccounts,
  type ResolvedDreamMakerAccount
} from './jobs/dreammaker-accounts.js';
import {
  parseHiggsfieldAccounts,
  type HiggsfieldAccountLine,
  type ParsedHiggsfieldAccounts
} from './jobs/higgsfield-accounts.js';
import { JobRunner } from './jobs/job-runner.js';
import { createJobSchema, putSessionSchema } from './schemas.js';
import type { BrowserAdapter } from './adapters/adapter.js';
import type { CreditBalance, JobStatus, ProviderAccount, SessionRecord } from './types.js';
import { readMioraRequestJson } from './system-channels/miora-request-json.js';
import { MioraUploadIntentStore, type UploadIntentAssetInput } from './system-channels/miora-upload-intents.js';

const idParamsSchema = z.object({ id: z.string().min(1).max(200) });
const listJobsQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
const uploadIntentSchema = z.object({
  idempotencyKey: z.string().min(16).max(200),
  // New clients send the eventual video options so account selection can reserve
  // enough credits before account-scoped COS uploads begin. Optional for older clients.
  options: z.looseObject({
    modelId: z.string().optional(),
    resolution: z.string().optional(),
    durationSeconds: z.number().positive().optional(),
    aspectRatio: z.string().optional(),
    quantity: z.number().positive().optional()
  }).optional(),
  assets: z.array(z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.int().positive(),
    mimeType: z.string().min(3).max(100), kind: z.enum(['image', 'video', 'audio']),
    fileName: z.string().min(1).optional(), publicUrl: z.string().url().optional()
  })).min(1)
});
const stagedUploadIntentSchema = uploadIntentSchema.omit({ assets:true }).extend({ assetCount:z.int().positive() });
const manifestWindowSchema = z.object({ offset:z.int().nonnegative(), assets:uploadIntentSchema.shape.assets });
// Window bounds are transport work budgets; there is no total manifest/reference cap.
const uploadItemsQuerySchema = z.object({ offset:z.coerce.number().int().nonnegative().default(0), limit:z.coerce.number().int().min(1).max(100).default(3) });
const completeSummarySchema = z.object({ summary:z.enum(['true','false']).optional() });
const completeUploadIntentSchema = z.object({ indexes: z.array(z.int().nonnegative()).min(1) });
/**
 * What `/v1/assets` accepts.
 *
 * Video is here for Higgsfield's `video_edit`, which edits a reference clip
 * rather than a still — and bills by that clip's own duration, so a caller
 * that cannot upload one cannot use the mode at all. The other two channels
 * only ever ask for stills; handing them a video asset is their own error to
 * report, not something this endpoint can decide.
 */
const supportedAssetTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm'
]);
const MIN_RETAINED_HAILUO_CREDITS = 28;
/** Old desktop clients omit upload-intent options; reserve the provider's maximum H3 duration. */
const MIORA_UPLOAD_INTENT_FALLBACK_DURATION_SECONDS = 15;

export async function buildApp(options: { managedChannels?: ChannelStore; managedGateway?: boolean; comfyui?: ComfyRuntimeOptions; managedAccountCreditReader?:ManagedAccountCreditReader; managedAccountArchived?:(id:string,reason:ManagedArchiveReason)=>void; trustProxy?: boolean | string[]; warmup?: boolean } = {}) {
  if (options.managedGateway && !options.managedChannels) throw new Error('Managed video gateway requires managed channels');
  assertVideoGatewayConfiguration(options.managedGateway === true, config.apiKey);
  assertVideoGatewayProxyConfiguration(options.managedGateway === true, config.mioraProxyUrl);
  const gateway = options.managedGateway && options.managedChannels ? new ManagedVideoGatewayRecords(options.managedChannels, config.apiKey!) : undefined;
  if (options.comfyui && !gateway) throw new Error('ComfyUI requires the authenticated managed video gateway');
  const uploadIntents = gateway && options.managedChannels ? new MioraUploadIntentStore(options.managedChannels.db, config.apiKey!) : undefined;
  const mioraTransfers = new MioraCosTransferCoordinator();
  const app = Fastify({ logger: systemLoggerOptions, trustProxy: options.trustProxy ?? false, bodyLimit: 2 * 1024 * 1024 });
  const mioraDiagnosticSink = new MioraDiagnosticSink(app.log);
  app.addHook('onRequest', (request, _reply, done) => {
    withMioraDiagnostics(mioraDiagnosticSink, { requestId:request.id }, done);
  });
  /** Accounts seen at 0 credits, kept so `/v1/accounts` can report them. */
  const exhaustedAccounts = new Map<string, AccountSnapshot>();
  const assets = new AssetStore(config.dataDir, {
    onError: (error, fileName) => app.log.warn({ err: error, fileName }, 'Skipped unreadable upload')
  });
  const comfy = options.comfyui ? createComfyService({ ...options.comfyui, db: options.managedChannels!.db,
    dataDirectory: config.dataDir, apiKey: config.apiKey!, assets, ownsAsset: id => gateway!.hasAsset(id),
    eventSink: event => app.log.info({ comfyEvent: event }, 'ComfyUI pool event') }) : undefined;
  if (comfy) app.log.info({ component: 'comfyui', autoOpen: comfy.options.configuration.autoOpen,
    instances: comfy.options.configuration.instances.map(instance => ({ id: instance.id, areaName: instance.areaName, gpuModel: instance.gpuModel })),
    workflows: comfy.options.configuration.workflows.map(profile => ({ id: profile.id, version: profile.version })),
    capacityPollIntervalMs: comfy.options.configuration.capacityPollIntervalMs ?? 30_000,
    capacityWaitTimeoutMs: comfy.options.configuration.capacityWaitTimeoutMs ?? 21_600_000,
  }, 'ComfyUI pool enabled');
  if (comfy) app.addHook('onReady', async () => { comfy.start(); });
  const sessions = options.managedChannels ? new ManagedSessionStore(config.dataDir, options.managedChannels) : new SessionStore(config.dataDir);
  const jobs = new JobStore({
    dataDir: config.dataDir,
    onError: (error, jobId) => app.log.error({ err: error, jobId }, 'Failed to persist job record')
  });
  // The proxy covers Hailuo and nothing else: the signed API calls here and the
  // browser, which only ever visits Hailuo too. Reference-image uploads go
  // straight to Aliyun OSS and stay direct.
  useHailuoProxy(config.hailuoProxyUrl);
  if (config.hailuoTransport === 'browser') {
    // Fail at boot rather than silently running the api path under a browser label.
    throw new Error(
      'HAILUO_TRANSPORT=browser is not implemented yet (see docs/browser-injected-api.md); use HAILUO_TRANSPORT=api'
    );
  }
  app.log.info({ transport: config.hailuoTransport }, 'Hailuo transport');
  app.log.info(
    {
      mode: config.hailuoProxyMode,
      proxy: maskProxyUrl(config.hailuoProxyUrl),
      proxied: [new URL(config.hailuoCreateUrl).host],
      direct: 'everything else, including Aliyun OSS reference-image uploads'
    },
    config.hailuoProxyUrl
      ? `Hailuo traffic exits through the ${config.hailuoProxyMode} proxy`
      : 'No proxy configured — all traffic is direct'
  );
  const browsers = new BrowserPool(
    config.browserPoolSize,
    config.browserHeadless,
    config.hailuoProxyUrl
  );
  const adapters = new AdapterRegistry();
  const balanceReporter = new AccountBalanceReporter(config.dataDir);
  const tokenFilePruner = new TokenFilePruner(config.hailuoTokenFile);
  /** sessionId -> raw token for every line currently in tokens.txt. */
  const configuredTokens = new Map<string, string>();
  /** sessionId -> resolved account for every line currently in the DreamMaker file. */
  const configuredDreamMakerAccounts = new Map<string, ResolvedDreamMakerAccount>();
  /** sessionId -> line for every account currently in the Higgsfield file. */
  const configuredHiggsfieldAccounts = new Map<string, HiggsfieldAccountLine>();
  /** sessionId -> resolved account for every line currently in the Miora file. */
  const configuredMioraAccounts = new Map<string, ResolvedMioraAccount>();
  const mioraAccountPruner = new MioraAccountPruner(config.mioraAccountFile, async (sessionId, expected) => {
    try {
      const archived = await archiveMioraExports(
        config.mioraImportDir, path.join(config.dataDir, 'miora-imports-archive'), sessionId, expected
      );
      if (archived) app.log.info({ sessionId, archived }, '已归档清理账号的旧 Miora 导出，避免重新导入');
    } catch (error) {
      // The credential was removed successfully; archive failures must never restore it.
      app.log.error({ err: error, sessionId }, 'Miora 账号已清理，但旧导出归档失败，下次导入后会重新核验');
    }
  });
  const minimumMioraCredits = mioraMinimumVideoCredits(config.mioraVideo.model);

  const hailuo = new HailuoAdapter(config.hailuoCreateUrl, {
    video: {
      modelId: config.hailuoVideo.modelId,
      resolution: config.hailuoVideo.resolution,
      duration: config.hailuoVideo.duration,
      aspectRatio: config.hailuoVideo.aspectRatio,
      referenceMode: config.hailuoVideo.referenceMode,
      frameType: config.hailuoVideo.frameType
    },
    pollTimeoutMs: config.hailuoPollTimeoutMs,
    pollIntervalMs: config.hailuoPollIntervalMs,
    retryDelaysMs: config.hailuoRetryDelaysMs
  });
  app.log.info(
    { retryDelaysMs: config.hailuoRetryDelaysMs, pollTimeoutMs: config.hailuoPollTimeoutMs },
    config.hailuoRetryDelaysMs.length
      ? `Hailuo steps are retried ${config.hailuoRetryDelaysMs.length} times before a job fails`
      : 'Hailuo retries are disabled'
  );
  // DreamMaker needs no browser and no signature, so it is wired as a plain
  // API adapter; its accounts come from their own file, see below.
  useDreamMakerProxy(config.dreamMakerProxyUrl);
  const dreamMaker = new DreamMakerAdapter(config.dreamMakerOrigin, {
    video: {
      model: config.dreamMakerVideo.model,
      mode: config.dreamMakerVideo.mode,
      resolution: config.dreamMakerVideo.resolution,
      durationSeconds: config.dreamMakerVideo.duration,
      aspectRatio: config.dreamMakerVideo.aspectRatio
    },
    pollTimeoutMs: config.dreamMakerPollTimeoutMs,
    pollIntervalMs: config.dreamMakerPollIntervalMs,
    retryDelaysMs: config.dreamMakerRetryDelaysMs
  });
  const dreamMakerCredentials = new DreamMakerCredentials(config.dreamMakerOrigin);

  // Higgsfield speaks its own MCP server. The credential is an OAuth refresh
  // token, and the adapter mints day-long access tokens from it, so nothing
  // here has to be renewed on a timer.
  useHiggsfieldMcpProxy(config.higgsfieldProxyUrl);
  const higgsfield = new HiggsfieldAdapter({
    video: {
      model: config.higgsfieldVideo.model,
      mode: config.higgsfieldVideo.mode,
      resolution: config.higgsfieldVideo.resolution,
      durationSeconds: config.higgsfieldVideo.duration,
      aspectRatio: config.higgsfieldVideo.aspectRatio
    },
    editSeedVideoPath: config.higgsfieldVideo.editSeedVideo,
    editSeedVideoSeconds: config.higgsfieldVideo.editSeedSeconds,
    pollTimeoutMs: config.higgsfieldPollTimeoutMs,
    pollIntervalMs: config.higgsfieldPollIntervalMs,
    retryDelaysMs: config.higgsfieldRetryDelaysMs
  });

  // Miora needs no browser and no signature either: an account is an authToken
  // (+ a refresh token this service renews from). Reached over its /api/ai REST
  // API; wired for the minimax-h3 model only.
  useMioraProxy(config.mioraProxyUrl, config.mioraLocalProxyUrl, config.mioraProxyAddress, options.managedGateway === true);
  const mioraCredentials = new MioraCredentials({ onExpired: removeExpiredMioraAccount });
  const miora = new MioraAdapter({
    video: {
      model: config.mioraVideo.model,
      resolution: config.mioraVideo.resolution,
      durationSeconds: config.mioraVideo.duration,
      aspectRatio: config.mioraVideo.aspectRatio
    },
    pollTimeoutMs: config.mioraPollTimeoutMs,
    pollIntervalMs: config.mioraPollIntervalMs,
    retryDelaysMs: config.mioraRetryDelaysMs,
    onTokens: persistMioraClientRenewal
  });

  adapters.register(new DemoAdapter(config.publicBaseUrl));
  adapters.register(hailuo);
  adapters.register(dreamMaker);
  adapters.register(higgsfield);
  adapters.register(miora);
  await Promise.all([assets.initialize(), sessions.initialize(), jobs.initialize()]);

  /**
   * tokens.txt is the source of truth for Hailuo sessions, at boot and while
   * running: lines added appear as accounts, lines removed drop out (once their
   * running jobs finish), and a replaced token re-credentials its account.
   */
  async function applyHailuoTokens(parsed: ParsedTokenFile, context: { initial: boolean }): Promise<void> {
    const origin = new URL(config.hailuoCreateUrl).origin;
    const wanted = new Map(parsed.tokens.map((entry) => [entry.sessionId, entry]));
    const stored = (await sessions.list()).filter((session) => session.adapterId === hailuo.id);
    const storedTokens = new Map(stored.map((session) => [session.id, readTokenCookie(session.cookies)]));

    // A token that vanished while jobs still run on it (typically pruned for a
    // low balance right after those jobs were charged) must not take its session
    // with it: the running polls need the credentials, and so does a resume
    // after a restart. Retire the account instead and delete it once idle.
    const removed: string[] = [];
    const retired: string[] = [];
    for (const session of stored) {
      if (wanted.has(session.id)) continue;
      if (hasUnfinishedJobs(session.id)) {
        accountPool.retire(session.id);
        retired.push(session.id);
      } else {
        await sessions.delete(session.id);
        accountPool.unretire(session.id);
        removed.push(session.id);
      }
    }

    const added: string[] = [];
    const updated: string[] = [];
    for (const { sessionId, token } of parsed.tokens) {
      // Configured again: back in service, whatever happened before.
      accountPool.unretire(sessionId);
      const current = storedTokens.get(sessionId);
      if (current === token) continue;
      await sessions.put(sessionId, hailuo.id, hailuoTokenCookies(token, origin));
      (current === undefined ? added : updated).push(sessionId);
    }

    configuredTokens.clear();
    for (const { sessionId, token } of parsed.tokens) configuredTokens.set(sessionId, token);
    for (const sessionId of removed) exhaustedAccounts.delete(sessionId);

    for (const duplicate of parsed.duplicates) {
      app.log.warn(
        { ...duplicate, tokenFile: config.hailuoTokenFile },
        'Ignored token line: an earlier line already names this account'
      );
    }
    app.log.info(
      {
        tokenFile: config.hailuoTokenFile,
        total: parsed.tokens.length,
        added: added.map((sessionId) => ({ sessionId, account: describeHailuoToken(configuredTokens.get(sessionId)!) })),
        updated,
        removed,
        retired
      },
      context.initial ? 'Hailuo token file loaded' : 'Hailuo token file reloaded'
    );
    if (retired.length) {
      app.log.warn(
        { retired },
        'Tokens removed while jobs still run on them: accounts retired, sessions kept until those jobs finish'
      );
    }

    // At boot the pool reads every balance right after this; later changes only
    // need the accounts that actually changed.
    if (!context.initial && (added.length || updated.length || removed.length || retired.length)) {
      await accountPool.refresh([...added, ...updated]);
    }
  }

  /**
   * The DreamMaker account file is the source of truth for that channel, the
   * same way tokens.txt is for Hailuo. A line is either an access token or
   * `username:password`; password lines are logged in here and renewed on a
   * timer, so only this function ever sees a password.
   */
  async function applyDreamMakerAccounts(
    parsed: ParsedDreamMakerAccounts,
    context: { initial: boolean }
  ): Promise<void> {
    const { accounts, failures } = await dreamMakerCredentials.resolve(parsed);
    const wanted = new Set(accounts.map((account) => account.sessionId));
    const stored = (await sessions.list()).filter((session) => session.adapterId === dreamMaker.id);
    const storedTokens = new Map(stored.map((session) => [session.id, readDreamMakerToken(session.cookies)]));

    // Same rule as Hailuo: an account that vanished while jobs still run on it
    // is retired rather than deleted, so those jobs keep their credentials.
    const removed: string[] = [];
    const retired: string[] = [];
    for (const session of stored) {
      if (wanted.has(session.id)) continue;
      if (hasUnfinishedJobs(session.id)) {
        accountPool.retire(session.id);
        retired.push(session.id);
      } else {
        await sessions.delete(session.id);
        accountPool.unretire(session.id);
        removed.push(session.id);
      }
    }

    const added: string[] = [];
    const updated: string[] = [];
    for (const account of accounts) {
      accountPool.unretire(account.sessionId);
      const current = storedTokens.get(account.sessionId);
      if (current === account.token) continue;
      await sessions.put(
        account.sessionId,
        dreamMaker.id,
        dreamMakerTokenCookies(account.token, config.dreamMakerOrigin)
      );
      (current === undefined ? added : updated).push(account.sessionId);
    }

    configuredDreamMakerAccounts.clear();
    for (const account of accounts) configuredDreamMakerAccounts.set(account.sessionId, account);
    for (const sessionId of removed) exhaustedAccounts.delete(sessionId);

    for (const duplicate of parsed.duplicates) {
      app.log.warn(
        { ...duplicate, accountFile: config.dreamMakerAccountFile },
        'Ignored DreamMaker line: an earlier line already names this account'
      );
    }
    for (const invalid of parsed.invalid) {
      app.log.warn(
        { ...invalid, accountFile: config.dreamMakerAccountFile },
        'Ignored DreamMaker line: not an access token or username:password'
      );
    }
    for (const failure of failures) {
      app.log.error(
        { ...failure, accountFile: config.dreamMakerAccountFile },
        'DreamMaker login failed; the account is not available'
      );
    }
    app.log.info(
      {
        accountFile: config.dreamMakerAccountFile,
        total: accounts.length,
        added: added.map((sessionId) => ({
          sessionId,
          source: configuredDreamMakerAccounts.get(sessionId)?.source,
          expiresAt: configuredDreamMakerAccounts.get(sessionId)?.expiresAt
        })),
        updated,
        removed,
        retired
      },
      context.initial ? 'DreamMaker account file loaded' : 'DreamMaker account file reloaded'
    );

    if (!context.initial && (added.length || updated.length || removed.length || retired.length)) {
      await accountPool.refresh([...added, ...updated]);
    }
  }

  /**
   * Password accounts get a new token before the old one lapses (a DreamMaker
   * JWT lasts a week). Token lines cannot be renewed here — they have to be
   * replaced in the file, and `/v1/accounts` shows when each one expires.
   */
  async function refreshDreamMakerTokens(): Promise<void> {
    const { accounts, failures } = await dreamMakerCredentials.refresh();
    for (const account of accounts) {
      await sessions.put(
        account.sessionId,
        dreamMaker.id,
        dreamMakerTokenCookies(account.token, config.dreamMakerOrigin)
      );
      configuredDreamMakerAccounts.set(account.sessionId, account);
    }
    for (const failure of failures) {
      app.log.error({ ...failure }, 'DreamMaker token renewal failed; the account keeps its old token until it lapses');
    }
    if (accounts.length) {
      app.log.info(
        { accounts: accounts.map((a) => ({ sessionId: a.sessionId, expiresAt: a.expiresAt })) },
        'Renewed DreamMaker access tokens'
      );
      await accountPool.refresh(accounts.map((account) => account.sessionId));
    }
  }

  /**
   * The Higgsfield account file, on the same terms as the other two: the file
   * is the source of truth, lines added appear as accounts and lines removed
   * drop out once their running jobs finish.
   *
   * Nothing is renewed here. What a line stores is an OAuth refresh token for
   * Higgsfield's MCP server; the day-long access tokens are minted from it
   * inside the adapter — so unlike DreamMaker there is no timer and no login.
   */
  async function applyHiggsfieldAccounts(
    parsed: ParsedHiggsfieldAccounts,
    context: { initial: boolean }
  ): Promise<void> {
    const wanted = new Set(parsed.accounts.map((account) => account.sessionId));
    const stored = (await sessions.list()).filter((session) => session.adapterId === higgsfield.id);
    const storedTokens = new Map(stored.map((session) => {
      const tokens = readHiggsfieldMcpTokens(session.cookies);
      return [session.id, tokens?.refreshToken ?? tokens?.accessToken];
    }));

    // Same rule as the other channels: an account that vanished while jobs
    // still run on it is retired rather than deleted, so those jobs keep their
    // credentials — including a resume after a restart.
    const removed: string[] = [];
    const retired: string[] = [];
    for (const session of stored) {
      if (wanted.has(session.id)) continue;
      if (hasUnfinishedJobs(session.id)) {
        accountPool.retire(session.id);
        retired.push(session.id);
      } else {
        await sessions.delete(session.id);
        accountPool.unretire(session.id);
        removed.push(session.id);
      }
    }

    const added: string[] = [];
    const updated: string[] = [];
    for (const account of parsed.accounts) {
      accountPool.unretire(account.sessionId);
      const token = account.tokens.refreshToken ?? account.tokens.accessToken!;
      const current = storedTokens.get(account.sessionId);
      if (current === token) continue;
      await sessions.put(
        account.sessionId,
        higgsfield.id,
        higgsfieldMcpCookies(account.tokens, config.higgsfieldSiteOrigin)
      );
      (current === undefined ? added : updated).push(account.sessionId);
    }

    configuredHiggsfieldAccounts.clear();
    for (const account of parsed.accounts) configuredHiggsfieldAccounts.set(account.sessionId, account);
    for (const sessionId of removed) exhaustedAccounts.delete(sessionId);

    for (const duplicate of parsed.duplicates) {
      app.log.warn(
        { ...duplicate, accountFile: config.higgsfieldAccountFile },
        'Ignored Higgsfield line: an earlier line already names this account'
      );
    }
    for (const invalid of parsed.invalid) {
      app.log.warn(
        { ...invalid, accountFile: config.higgsfieldAccountFile },
        'Ignored Higgsfield line: not an MCP credential this service can use'
      );
    }
    for (const account of parsed.accounts) {
      if (account.tokens.refreshToken) continue;
      app.log.warn(
        { sessionId: account.sessionId, line: account.line, accountFile: config.higgsfieldAccountFile },
        'Higgsfield line has no refresh token: this account stops working when its access token lapses'
      );
    }
    app.log.info(
      {
        accountFile: config.higgsfieldAccountFile,
        total: parsed.accounts.length,
        added,
        updated,
        removed,
        retired
      },
      context.initial ? 'Higgsfield account file loaded' : 'Higgsfield account file reloaded'
    );

    if (!context.initial && (added.length || updated.length || removed.length || retired.length)) {
      await accountPool.refresh([...added, ...updated]);
    }
  }

  const mioraRenewals = new Map<string, Promise<void>>();

  async function removeExpiredMioraAccount(
    sessionId: string, expected: MioraTokens, reason: 'NO_REFRESH_TOKEN' | 'REFRESH_TOKEN_DEAD'
  ): Promise<boolean> {
    try {
      if (!await mioraAccountPruner.remove(sessionId, expected)) return false;
    } catch (error) {
      app.log.error({ err: error, sessionId }, 'Miora 过期账号自动清理失败，保留账号等待下次检查');
      return false;
    }
    const current = configuredMioraAccounts.get(sessionId)?.tokens;
    // A newer credential installed while the file edit awaited must keep serving jobs.
    if (current && (current.authToken !== expected.authToken
      || current.refreshToken !== expected.refreshToken || current.cookie !== expected.cookie)) return true;
    configuredMioraAccounts.delete(sessionId);
    accountPool.retire(sessionId);
    try { await releaseRetiredSession(sessionId); } catch (error) {
      app.log.error({ err: error, sessionId }, 'Miora 过期凭证已移除，会话清理失败，保留退役会话');
    }
    app.log.warn(
      { sessionId, reason, accountFile: config.mioraAccountFile },
      'Miora 访问令牌已过期且无法续期，已自动清理账号；在途任务保留会话'
    );
    return true;
  }

  async function storeMioraRenewal(sessionId: string, previous: MioraTokens, renewed: MioraTokens): Promise<void> {
    const prior = mioraRenewals.get(sessionId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async () => {
      const current = configuredMioraAccounts.get(sessionId);
      if (!current || current.tokens.authToken !== previous.authToken
        || current.tokens.refreshToken !== previous.refreshToken) {
        throw new Error('Miora account changed while its token was being renewed');
      }
      if (!await persistMioraRenewal(config.mioraAccountFile, sessionId, previous, renewed)) {
        throw new Error('Miora account file changed while its token was being renewed');
      }
      const account = mioraCredentials.acceptRenewal(sessionId, previous, renewed);
      if (!account) throw new Error('Miora token renewal was superseded');
      await sessions.put(sessionId, miora.id, mioraTokenCookies(account.tokens));
      configuredMioraAccounts.set(sessionId, account);
    });
    mioraRenewals.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (mioraRenewals.get(sessionId) === operation) mioraRenewals.delete(sessionId);
    }
  }

  async function persistMioraClientRenewal(previous: MioraTokens, renewed: MioraTokens): Promise<void> {
    const account = [...configuredMioraAccounts.values()].find((entry) =>
      entry.tokens.authToken === previous.authToken
      && entry.tokens.refreshToken === previous.refreshToken
    );
    if (account) {
      await storeMioraRenewal(account.sessionId, previous, renewed);
      return;
    }
    // Sessions added directly through the API have no account-file line to update.
    const session = (await sessions.list()).find((candidate) => {
      if (candidate.adapterId !== miora.id) return false;
      const tokens = readMioraTokens(candidate.cookies);
      return tokens?.authToken === previous.authToken
        && tokens?.refreshToken === previous.refreshToken;
    });
    if (!session) throw new Error('Miora account changed while its token was being renewed');
    await sessions.put(session.id, miora.id, mioraTokenCookies(renewed));
  }

  /**
   * The Miora account file, on the same terms as the others: the file is the
   * source of truth, lines added appear as accounts and lines removed drop out
   * once their running jobs finish. `resolve` renews an authToken from its
   * refresh token when it is already near expiry (or carries no scopes), so an
   * account is usable from the first job.
   */
  async function applyMioraAccounts(
    parsed: ParsedMioraAccounts,
    context: { initial: boolean }
  ): Promise<void> {
    const { accounts, failures } = await mioraCredentials.resolve(parsed);
    // resolve() can renew an expiring token on startup; persist that rotated pair too.
    for (const account of accounts) {
      const original = parsed.accounts.find((entry) => entry.sessionId === account.sessionId)?.tokens;
      if (!original || (original.authToken === account.tokens.authToken
        && original.refreshToken === account.tokens.refreshToken)) continue;
      try {
        if (!await persistMioraRenewal(config.mioraAccountFile, account.sessionId, original, account.tokens)) {
          app.log.warn({ sessionId: account.sessionId }, 'Miora account file changed during startup renewal');
        }
      } catch (error) {
        app.log.error({ err: error, sessionId: account.sessionId }, 'Miora startup renewal could not be persisted');
      }
    }
    const wanted = new Set(accounts.map((account) => account.sessionId));
    const stored = (await sessions.list()).filter((session) => session.adapterId === miora.id && !options.managedChannels?.row(session.id));
    const storedTokens = new Map(
      stored.map((session) => [session.id, readMioraTokens(session.cookies)?.authToken])
    );

    const removed: string[] = [];
    const retired: string[] = [];
    for (const session of stored) {
      if (wanted.has(session.id)) continue;
      if (hasUnfinishedJobs(session.id)) {
        accountPool.retire(session.id);
        retired.push(session.id);
      } else {
        await sessions.delete(session.id);
        accountPool.unretire(session.id);
        removed.push(session.id);
      }
    }

    const added: string[] = [];
    const updated: string[] = [];
    for (const account of accounts) {
      accountPool.unretire(account.sessionId);
      const current = storedTokens.get(account.sessionId);
      const storedSession = stored.find((session) => session.id === account.sessionId);
      const storedCredential = storedSession && readMioraTokens(storedSession.cookies);
      if (current === account.tokens.authToken
        && storedCredential?.refreshToken === account.tokens.refreshToken
        && storedCredential?.cookie === account.tokens.cookie) continue;
      await sessions.put(account.sessionId, miora.id, mioraTokenCookies(account.tokens));
      (current === undefined ? added : updated).push(account.sessionId);
    }

    configuredMioraAccounts.clear();
    for (const account of accounts) configuredMioraAccounts.set(account.sessionId, account);
    for (const sessionId of removed) exhaustedAccounts.delete(sessionId);

    for (const duplicate of parsed.duplicates) {
      app.log.warn(
        { ...duplicate, accountFile: config.mioraAccountFile },
        'Ignored Miora line: an earlier line already names this account'
      );
    }
    for (const invalid of parsed.invalid) {
      app.log.warn(
        { ...invalid, accountFile: config.mioraAccountFile },
        'Ignored Miora line: not a credential this service can use'
      );
    }
    for (const failure of failures) {
      app.log.error(
        { ...failure, accountFile: config.mioraAccountFile },
        'Miora token renewal failed on load; the account keeps its configured token'
      );
    }
    for (const account of accounts) {
      if (!account.tokens.refreshToken) {
        app.log.warn(
          { sessionId: account.sessionId, accountFile: config.mioraAccountFile },
          'Miora line has no refresh token: this account stops working when its authToken lapses'
        );
      }
    }
    app.log.info(
      {
        accountFile: config.mioraAccountFile,
        total: accounts.length,
        added: added.map((sessionId) => ({
          sessionId,
          expiresAt: configuredMioraAccounts.get(sessionId)?.expiresAt,
          scoped: configuredMioraAccounts.get(sessionId)?.scoped
        })),
        updated,
        removed,
        retired
      },
      context.initial ? 'Miora account file loaded' : 'Miora account file reloaded'
    );

    if (!context.initial && (added.length || updated.length || removed.length || retired.length)) {
      await accountPool.refresh([...added, ...updated]);
    }
  }

  /** Renew Miora authTokens that are about to lapse; token lines with no refresh token cannot be renewed. */
  async function refreshMioraTokens(): Promise<void> {
    const { accounts, failures, removed } = await mioraCredentials.refresh();
    for (const account of accounts) {
      const previous = configuredMioraAccounts.get(account.sessionId)?.tokens;
      if (!previous) continue;
      try {
        await storeMioraRenewal(account.sessionId, previous, account.tokens);
      } catch (error) {
        app.log.error({ err: error, sessionId: account.sessionId }, 'Miora token renewal could not be persisted');
      }
    }
    for (const failure of failures) {
      app.log.error({ ...failure }, 'Miora token renewal failed; the account keeps its old token until it lapses');
    }
    if (accounts.length) {
      app.log.info(
        { accounts: accounts.map((a) => ({ sessionId: a.sessionId, expiresAt: a.expiresAt })) },
        'Renewed Miora auth tokens'
      );
      await accountPool.refresh(accounts.map((account) => account.sessionId));
    }
    if (removed.length) await accountPool.snapshot({ refresh: false });
    // The final lease may finish its asynchronous balance refresh after onJobSettled.
    for (const session of await sessions.list()) {
      if (session.adapterId === miora.id && accountPool.isRetired(session.id)) {
        await releaseRetiredSession(session.id);
      }
    }
  }

  function hasUnfinishedJobs(sessionId: string): boolean {
    return jobs.list().some((job) =>
      job.sessionId === sessionId && (job.status === 'queued' || job.status === 'running'));
  }

  /** A retired account whose last job just finished can finally go. */
  async function releaseRetiredSession(sessionId: string): Promise<void> {
    if (options.managedChannels?.row(sessionId)) return;
    const stillConfigured = configuredTokens.has(sessionId)
      || configuredDreamMakerAccounts.has(sessionId)
      || configuredHiggsfieldAccounts.has(sessionId)
      || configuredMioraAccounts.has(sessionId);
    if (!accountPool.isRetired(sessionId) || stillConfigured) return;
    if (hasUnfinishedJobs(sessionId) || accountPool.activeJobs(sessionId) > 0) return;
    await sessions.delete(sessionId);
    accountPool.unretire(sessionId);
    exhaustedAccounts.delete(sessionId);
    await accountPool.sync();
    app.log.info({ sessionId }, 'Retired account finished its last job and was removed');
  }

  const tokenWatcher = new TokenFileWatcher(config.hailuoTokenFile, applyHailuoTokens, {
    pollIntervalMs: config.hailuoTokenPollMs,
    onError: (error) => app.log.error({ err: error, tokenFile: config.hailuoTokenFile }, 'Hailuo token file watch failed')
  });

  const dreamMakerWatcher = new TokenFileWatcher(config.dreamMakerAccountFile, applyDreamMakerAccounts, {
    parse: parseDreamMakerAccounts,
    pollIntervalMs: config.hailuoTokenPollMs,
    onError: (error) => app.log.error(
      { err: error, accountFile: config.dreamMakerAccountFile },
      'DreamMaker account file watch failed'
    )
  });

  const higgsfieldWatcher = new TokenFileWatcher(config.higgsfieldAccountFile, applyHiggsfieldAccounts, {
    parse: parseHiggsfieldAccounts,
    pollIntervalMs: config.hailuoTokenPollMs,
    onError: (error) => app.log.error(
      { err: error, accountFile: config.higgsfieldAccountFile },
      'Higgsfield account file watch failed'
    )
  });

  const mioraWatcher = new TokenFileWatcher(config.mioraAccountFile, applyMioraAccounts, {
    parse: parseMioraAccounts,
    pollIntervalMs: config.hailuoTokenPollMs,
    onError: (error) => app.log.error(
      { err: error, accountFile: config.mioraAccountFile },
      'Miora account file watch failed'
    )
  });

  // Exports dropped into the import directory become account lines; the watcher above then loads them.
  const mioraImportWatcher = new MioraImportWatcher(config.mioraImportDir, config.mioraAccountFile, {
    onImport: (report) => {
      const changed = report.results.filter((result) => result.status === 'added' || result.status === 'updated');
      for (const skipped of report.skipped) {
        app.log.warn({ ...skipped, importDir: config.mioraImportDir }, 'Ignored Miora export');
      }
      if (!changed.length) return;
      app.log.info(
        {
          importDir: config.mioraImportDir,
          accountFile: config.mioraAccountFile,
          accounts: changed.map(({ sessionId, email, status, source }) => ({ sessionId, email, status, source }))
        },
        'Imported Miora exports'
      );
    },
    onError: (error) => app.log.error(
      { err: error, importDir: config.mioraImportDir },
      'Miora export import failed'
    )
  });

  /** Only the adapter can read its own credential, so it names the account. */
  function describeSession(session: SessionRecord): SessionSummary {
    const identity = adapters.get(session.adapterId)?.describeSession?.(session.cookies);
    return {
      sessionId: session.id,
      adapterId: session.adapterId,
      account: identity?.account,
      updatedAt: session.updatedAt
    };
  }

  async function loadCredits(session: SessionRecord, adapter: BrowserAdapter): Promise<CreditBalance> {
    const direct = await adapter.getCreditsFromCookies?.(session.cookies);
    if (direct) return direct;

    const getCredits = adapter.getCredits?.bind(adapter);
    if (!getCredits) throw new Error('Adapter does not support credit queries');

    return browsers.use(async (browser) => {
      const context = await browser.newContext();
      try {
        if (session.cookies.length) await context.addCookies(session.cookies);
        return await getCredits(await context.newPage());
      } finally {
        await context.close();
      }
    });
  }

  let managedAccountOperations:ManagedAccountOperations|undefined;
  const accountPool = new AccountPool(sessions, adapters, {
    creditsTtlMs: config.creditsCacheTtlMs,
    creditsRetryDelaysMs: config.hailuoRetryDelaysMs,
    minimumRetainedCredits: (adapterId) => adapterId === hailuo.id
      ? MIN_RETAINED_HAILUO_CREDITS
      : adapterId === miora.id ? minimumMioraCredits : undefined,
    onBelowMinimum: async (snapshot, cookies) => {
      // Never turn a failed/unknown balance read into a destructive decision.
      if (!snapshot.creditsCheckedAt || snapshot.lastError || snapshot.credits === undefined
        || !Number.isFinite(snapshot.credits) || snapshot.credits < 0) return;
      if (snapshot.adapterId === miora.id) {
        if(options.managedChannels?.row(snapshot.sessionId))return managedAccountOperations?.confirmedBalance(snapshot.sessionId,cookies,snapshot.credits,snapshot.creditsCheckedAt);
        const account = configuredMioraAccounts.get(snapshot.sessionId);
        const expected = readMioraTokens(cookies);
        if (!account || !expected || minimumMioraCredits === undefined || snapshot.credits >= minimumMioraCredits) return;
        try {
          const removed = await mioraAccountPruner.remove(snapshot.sessionId, expected);
          if (removed) {
            configuredMioraAccounts.delete(snapshot.sessionId);
            accountPool.retire(snapshot.sessionId);
            app.log.warn(
              { sessionId: snapshot.sessionId, credits: snapshot.credits,
                creditsCheckedAt: snapshot.creditsCheckedAt, minimumCredits: minimumMioraCredits,
                minimumSeconds: 4, model: config.mioraVideo.model, accountFile: config.mioraAccountFile },
              `Miora 已读取积分 ${snapshot.credits}，不足 4 秒生成所需 ${minimumMioraCredits} 积分，已自动清理账号`
            );
          }
          return removed;
        } catch (error) {
          app.log.error(
            { err: error, sessionId: snapshot.sessionId, accountFile: config.mioraAccountFile },
            'Miora 低积分账号自动清理失败，保留账号'
          );
          return false;
        }
      }
      const token = configuredTokens.get(snapshot.sessionId);
      if (!token) return;
      try {
        const removed = await tokenFilePruner.remove(token);
        if (removed) {
          app.log.warn(
            { sessionId: snapshot.sessionId, credits: snapshot.credits, tokenFile: config.hailuoTokenFile },
            `Removed Hailuo token with fewer than ${MIN_RETAINED_HAILUO_CREDITS} credits`
          );
        }
      } catch (error) {
        app.log.error(
          { err: error, sessionId: snapshot.sessionId, tokenFile: config.hailuoTokenFile },
          'Failed to remove low-balance Hailuo token'
        );
      }
    },
    onExhausted: (snapshot) => {
      exhaustedAccounts.set(snapshot.sessionId, snapshot);
      app.log.warn(
        { sessionId: snapshot.sessionId, account: snapshot.account },
        'Hailuo account is out of credits — it will be skipped until it is topped up'
      );
    },
    onBalancesChanged: async (accounts) => {
      try {
        await balanceReporter.update(accounts);
      } catch (error) {
        app.log.warn({ err: error, filePath: balanceReporter.filePath }, 'Failed to update token balance report');
      }
    }
  });

  if(options.managedChannels){
    const managedChannels=options.managedChannels;
    managedAccountOperations=new ManagedAccountOperations(managedChannels,{
      minimumCredits:minimumMioraCredits,proxyUrl:config.mioraProxyUrl,proxyAddress:config.mioraProxyAddress,
      readCredits:options.managedAccountCreditReader,
      busy:id=>accountPool.activeJobs(id)>0||jobs.list().some(job=>job.sessionId===id&&(job.status==='queued'||job.status==='running')),
      onArchive:options.managedAccountArchived,
      changed:async()=>{const rows=managedChannels.db.prepare('SELECT id,enabled,archived_at FROM managed_channel_accounts').all() as {id:string;enabled:number;archived_at:string|null}[];for(const row of rows){if(row.enabled&&!row.archived_at)accountPool.unretire(row.id);else accountPool.retire(row.id);}await accountPool.sync();}
    });
  }

  const runner = new JobRunner(jobs, assets, sessions, adapters, browsers, accountPool, {
    runInContext:(jobId, run) => withMioraDiagnostics(mioraDiagnosticSink, { jobId }, run),
    beforeSubmitGuard: gateway ? job => gateway.assertExecution(job) : undefined,
    beforeQueryGuard: gateway ? job => gateway.assertQuery(job) : undefined,
    onAccountLeaseAcquired: uploadIntents ? job => uploadIntents.releaseReservationForJob(job.id) : undefined,
    timeoutMs: config.jobTimeoutMs,
    // Wide enough for every render attempt plus the waits between them; the
    // adapter's own per-render poll timeout is what actually bounds a job.
    directTimeoutMs: Math.max(
      hailuoJobBudgetMs({
        pollTimeoutMs: config.hailuoPollTimeoutMs,
        retryDelaysMs: config.hailuoRetryDelaysMs
      }),
      dreamMakerJobBudgetMs({
        pollTimeoutMs: config.dreamMakerPollTimeoutMs,
        retryDelaysMs: config.dreamMakerRetryDelaysMs
      }),
      higgsfieldJobBudgetMs({
        pollTimeoutMs: config.higgsfieldPollTimeoutMs,
        retryDelaysMs: config.higgsfieldRetryDelaysMs
      }),
      mioraJobBudgetMs({
        pollTimeoutMs: config.mioraPollTimeoutMs,
        retryDelaysMs: config.mioraRetryDelaysMs
      })
    ),
    onJobSettled: (job) => {
      if (job.adapterId === 'miora-v1') {
        mioraDiagnostic('miora.job.finished', { jobId:job.id, taskId:job.progress?.providerJobId, outcome:job.status, code:job.error?.code });
        mioraDiagnosticSink.flush();
      }
      uploadIntents?.releaseReservationForJob(job.id);
      if (!job.sessionId) return;
      void releaseRetiredSession(job.sessionId).catch((error) => {
        app.log.warn({ err: error, sessionId: job.sessionId }, 'Failed to remove retired Hailuo account');
      });
    }
  });

  await tokenWatcher.start();
  await dreamMakerWatcher.start();
  await higgsfieldWatcher.start();
  // Import first, so the initial account load already includes new exports.
  await mioraImportWatcher.start().catch((error: unknown) => {
    app.log.error({ err: error, importDir: config.mioraImportDir }, 'Miora import directory unavailable');
  });
  await mioraWatcher.start();
  const dreamMakerTokenTimer = setInterval(() => {
    void refreshDreamMakerTokens().catch((error: unknown) => {
      app.log.error({ err: error }, 'DreamMaker token renewal check failed');
    });
  }, config.dreamMakerTokenCheckMs);
  dreamMakerTokenTimer.unref();
  const mioraTokenTimer = setInterval(() => {
    void refreshMioraTokens().catch((error: unknown) => {
      app.log.error({ err: error }, 'Miora token renewal check failed');
    });
  }, config.mioraTokenCheckMs);
  mioraTokenTimer.unref();
  const checkManagedAccounts=()=>{if(config.mioraProxyUrl)managedAccountOperations?.schedule(options.managedChannels!.ids().filter(id=>!!options.managedChannels!.row(id)?.enabled));};
  const managedAccountTimer=managedAccountOperations?setInterval(checkManagedAccounts,60_000):undefined;
  managedAccountTimer?.unref();
  if(managedAccountOperations)app.addHook('onReady',async()=>{checkManagedAccounts();});
  if (options.warmup !== false) await browsers.initialize();

  // Read balances once at boot so a dead account is reported before any job.
  const initialAccounts = options.warmup === false ? [] : await accountPool.snapshot({ refresh: true }).catch((error) => {
    app.log.warn({ err: error }, 'Initial account credit check failed');
    return [];
  });
  app.log.info(
    {
      accounts: initialAccounts.map((a) => ({ sessionId: a.sessionId, credits: a.credits })),
      balanceReport: balanceReporter.filePath
    },
    'Account pool ready'
  );

  // Jobs from before the restart: finish what the provider is still rendering,
  // rerun what never started, and mark the rest so callers know to resubmit.
  const recovered = runner.recover();
  if (recovered.requeued.length || recovered.resumed.length || recovered.interrupted.length) {
    app.log.info(recovered, 'Recovered jobs from the previous run');
  }

  const jobRetentionMs = config.jobRetentionDays * 24 * 60 * 60_000;
  const pruneJobs = async () => {
    const pruned = await jobs.prune(jobRetentionMs).catch((error: unknown) => {
      app.log.warn({ err: error }, 'Job record pruning failed');
      return 0;
    });
    if (pruned) app.log.info({ pruned, retentionDays: config.jobRetentionDays }, 'Pruned old job records');
  };
  await pruneJobs();
  const pruneTimer = setInterval(() => void pruneJobs(), 60 * 60_000);
  pruneTimer.unref();

  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes, fields: 5 }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (options.managedChannels) {
      try { assertVideoGatewayRequest(request, !!gateway, config.apiKey); }
      catch (error) {
        if (error instanceof SystemError) return reply.code(error.statusCode).send(errorBody(error.code, error.message));
        throw error;
      }
      return;
    }
    if (!config.apiKey) return;
    if (request.headers['x-api-key'] !== config.apiKey) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    ...(comfy ? { comfyuiEnabled: true } : {}),
    ...(options.managedChannels ? { service: 'system', channelsEnabled: true, videoGatewayEnabled: !!gateway } : {}),
    browsers: browsers.stats(),
    adapters: adapters.list()
  }));

  app.get('/internal/demo-page', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(demoPageHtml);
  });

  app.post('/v1/assets', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send(errorBody('FILE_REQUIRED', comfy ? 'Upload one image, video or supported audio file' : 'Upload one image or video file'));
    const comfyAudio = !!comfy && ['audio/mpeg', 'audio/wav'].includes(file.mimetype);
    if (!supportedAssetTypes.has(file.mimetype) && !comfyAudio) {
      return reply.code(415).send(errorBody('UNSUPPORTED_FILE_TYPE', comfy ? 'Use PNG, JPEG, WebP, GIF, MP4, MOV, WebM, MP3 or WAV' : 'Use PNG, JPEG, WebP, GIF, MP4, MOV or WebM'));
    }

    const buffer = await file.toBuffer();
    if (!(comfyAudio ? validMediaSignature(file.mimetype, buffer) : matchesAssetSignature(buffer, file.mimetype))) {
      return reply.code(415).send(errorBody('FILE_SIGNATURE_MISMATCH', 'File content does not match MIME type'));
    }
    const asset = await assets.save({
      originalName: file.filename,
      mimeType: file.mimetype,
      buffer
    });
    gateway?.ownAsset(asset.id);
    return reply.code(201).send(publicAsset(asset));
  });

  const uploadFileName = (asset: UploadIntentAssetInput) => {
    const extensions: Record<string,string> = { 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif',
      'video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','audio/mpeg':'.mp3','audio/wav':'.wav',
      'audio/mp4':'.m4a','audio/flac':'.flac','audio/ogg':'.ogg' };
    const extension = extensions[asset.mimeType];
    if (!extension) throw new SystemError(400, 'UPLOAD_MEDIA_TYPE_UNSUPPORTED', `Unsupported reference media type: ${asset.mimeType}`);
    return `${asset.sha256}${extension}`;
  };

  async function intentAccounts() {
    const candidates = (await accountPool.snapshot({ loadCredits: true, adapterId: 'miora-v1' })).filter(account => {
      const row = options.managedChannels?.row(account.sessionId);
      return !!row?.enabled && !row.archived_at;
    });
    if (!candidates.length) throw new SystemError(400, 'NO_ACCOUNTS_AVAILABLE', 'No Miora account is configured');
    return candidates;
  }

  function renewActiveUploadIntent(id:string):void {
    const plan = uploadIntents!.page(id, 0, 1);
    if (plan.consumedJobId) return;
    const account = options.managedChannels!.row(plan.accountId);
    if (!account?.enabled || account.archived_at) throw new SystemError(409, 'UPLOAD_INTENT_ACCOUNT_UNAVAILABLE', 'Upload intent account is unavailable');
    uploadIntents!.renewActive(id);
  }

  async function signedPendingItems(id: string, window?: {offset:number;limit:number}) {
    return withMioraDiagnostics(mioraDiagnosticSink, { uploadIntentId:id }, () => signedPendingItemsInContext(id, window));
  }
  async function signedPendingItemsInContext(id: string, window?: {offset:number;limit:number}) {
    if (window) renewActiveUploadIntent(id);
    const description = window ? uploadIntents!.describePage(id, window.offset, window.limit) : uploadIntents!.describe(id);
    const describedItems = new Map(description.items.map(item => [item.index, item]));
    const plan = window ? uploadIntents!.page(id, window.offset, window.limit) : uploadIntents!.plan(id);
    if ('finalized' in plan && !plan.finalized) throw new SystemError(409, 'UPLOAD_MANIFEST_INCOMPLETE', 'Manifest is not finalized');
    const session = await sessions.get(plan.accountId);
    const tokens = session && readMioraTokens(session.cookies);
    if (!tokens) throw new SystemError(409, 'UPLOAD_INTENT_ACCOUNT_UNAVAILABLE', 'Upload intent account is unavailable');
    const client = new MioraClient(tokens, persistMioraClientRenewal);
    const items = [];
    for (const item of plan.items) {
      const publicItem = describedItems.get(item.idx) ?? { index:item.idx, status:item.status };
      if (item.status !== 'upload_required') { items.push(publicItem); continue; }
      const grant = await client.getCosGrant();
      const upload = prepareCosUpload(grant, uploadFileName({ sha256:item.sha256,size:item.size,mimeType:item.mime_type,kind:item.kind }), item.mime_type, item.size);
      uploadIntents!.assignUploadKey(id, item.idx, upload.key);
      items.push({ ...publicItem, upload: { method: 'PUT', url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt } });
    }
    return { ...description, items };
  }

  const importRuns = new Map<string,Promise<void>>();
  function resumePublicImports(id: string): void {
    if (importRuns.has(id)) return;
    const run = withMioraDiagnostics(mioraDiagnosticSink, { uploadIntentId:id }, async () => {
      mioraDiagnostic('miora.intent.import_started');
      const plan = uploadIntents!.page(id, 0, 1);
      if (plan.consumedJobId || !plan.finalized) return;
      const session = await sessions.get(plan.accountId);
      const tokens = session && readMioraTokens(session.cookies);
      if (!tokens) throw new SystemError(409, 'UPLOAD_INTENT_ACCOUNT_UNAVAILABLE', 'Upload intent account is unavailable');
      const client = new MioraClient(tokens, persistMioraClientRenewal);
      let offset = 0;
      for (;;) {
      const page = uploadIntents!.pendingImportPage(id, offset, 100);
      if (!page.length || mioraTransfers.signal.aborted) break;
      offset = page[page.length - 1]!.idx + 1;
      const pending = page.filter(item => item.source_url);
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (cursor < pending.length && !mioraTransfers.signal.aborted) {
          const item = pending[cursor++]!;
          await withMioraDiagnostics(mioraDiagnosticSink, { itemIndex:item.idx }, async () => {
          try {
            const key = await mioraTransfers.transfer({ accountId:plan.accountId,
              identity:`${item.sha256}:${item.size}:${item.mime_type}:${item.kind}`,
              run:() => transferPublicMediaToMioraCos({ client, sourceUrl:item.source_url!, allowedHosts:config.mioraPublicMediaHosts,
                fileName:uploadFileName({sha256:item.sha256,size:item.size,mimeType:item.mime_type,kind:item.kind}),
                mimeType:item.mime_type,size:item.size,sha256:item.sha256,signal:mioraTransfers.signal }) });
            uploadIntents!.importReady(id, item.idx, key);
          } catch (error) {
            const failure = describeMioraTransferFailure(error);
            app.log.warn({ uploadIntentId:id, index:item.idx, ...failure }, 'Public media transfer failed');
            uploadIntents!.importFailed(id, item.idx, failure);
          }
          });
        }
      }));
      }
    }).catch(error => {
      app.log.warn({ err:error, uploadIntentId:id }, 'Upload intent import recovery failed');
      const failure = error instanceof SystemError && error.code === 'UPLOAD_INTENT_ACCOUNT_UNAVAILABLE'
        ? {code:error.code,stage:'cos_grant' as const,retryable:false} : describeMioraTransferFailure(error);
      try {
        for (;;) {
          const pending=uploadIntents!.pendingImportPage(id,0,100);
          if(!pending.length)break;
          for(const item of pending)uploadIntents!.importFailed(id,item.idx,failure);
        }
      } catch(stateError) {app.log.warn({err:stateError,uploadIntentId:id},'Upload intent preparation failure could not be recorded');}
    })
      .finally(() => importRuns.delete(id));
    importRuns.set(id, run);
  }

  app.put('/v1/upload-intents/:id/manifest', { bodyLimit:1024 * 1024 }, async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params); const body = manifestWindowSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(validationError(params, body));
    uploadIntents.appendManifest(params.data.id, body.data.offset, body.data.assets);
    return reply.send(uploadIntents.summary(params.data.id));
  });
  // A single large scalar uses resource admission rather than a fixed JSON-frame quota.
  await app.register(async streamingManifest => {
    streamingManifest.removeContentTypeParser('application/json');
    streamingManifest.addHook('preParsing', async (request, _reply, payload) => {
      if (!uploadIntents) throw new SystemError(404, 'LEGACY_API_DISABLED', 'Video upload intents are disabled');
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) throw new SystemError(400, 'UPLOAD_INTENT_INVALID', 'Invalid upload intent');
      uploadIntents.summary(params.data.id); // Owner check before reading/allocating request bytes.
      return payload;
    });
    streamingManifest.addContentTypeParser('application/json', (request, payload, done) => {
      void readLegacyMediaJson(payload, 60_000).then(body => done(null, body), error => {
        if (error instanceof ProjectError) done(new SystemError(error.statusCode, error.code, error.message));
        else done(new SystemError(400, 'UPLOAD_MANIFEST_INVALID', 'Manifest JSON is invalid'));
      });
    });
    streamingManifest.put('/v1/upload-intents/:id/manifest-stream', async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params); const body = manifestWindowSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send(validationError(params, body));
      uploadIntents!.appendManifest(params.data.id, body.data.offset, body.data.assets);
      return reply.send(uploadIntents!.summary(params.data.id));
    });
  });

  app.post('/v1/upload-intents/:id/finalize', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(zodError(params.error));
    uploadIntents.finalizeManifest(params.data.id); resumePublicImports(params.data.id);
    return reply.send(uploadIntents.summary(params.data.id));
  });
  // Pure evidence read: no lease renewal, credential lookup, signing or import resume.
  app.get('/v1/upload-intents/:id/diagnostics', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params); const query = uploadItemsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send(validationError(params, query));
    return reply.send({ ...uploadIntents.describePage(params.data.id, query.data.offset, query.data.limit),
      observedAt:new Date().toISOString(), requestId:request.id });
  });
  app.get('/v1/upload-intents/:id/status', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(zodError(params.error));
    renewActiveUploadIntent(params.data.id);
    resumePublicImports(params.data.id);
    return reply.send(uploadIntents.summary(params.data.id));
  });
  app.get('/v1/upload-intents/:id/items', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params); const query = uploadItemsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send(validationError(params, query));
    return reply.send(await signedPendingItems(params.data.id, query.data));
  });

  app.get('/v1/upload-intents/:id', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(zodError(params.error));
    renewActiveUploadIntent(params.data.id);
    resumePublicImports(params.data.id);
    return reply.send(uploadIntents.describe(params.data.id));
  });

  app.post('/v1/upload-intents/:id/complete', async (request, reply) => {
    if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
    const params = idParamsSchema.safeParse(request.params); const body = completeUploadIntentSchema.safeParse(request.body);
    const query = completeSummarySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(zodError(query.error));
    if (!params.success || !body.success) return reply.code(400).send(validationError(params, body));
    uploadIntents.directUploadItems(params.data.id, body.data.indexes);
    uploadIntents.complete(params.data.id, body.data.indexes);
    return reply.send(query.data.summary === 'true' ? uploadIntents.summary(params.data.id) : uploadIntents.describe(params.data.id));
  });

  app.put('/v1/sessions/:id/cookies', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = putSessionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(validationError(params, body));
    }
    const adapter = adapters.get(body.data.adapterId);
    if (!adapter) {
      return reply.code(400).send(errorBody('ADAPTER_NOT_FOUND', 'Unknown adapter'));
    }
    if (!body.data.cookies.every((cookie) => cookieAllowed(cookie, adapter.allowedCookieDomains))) {
      return reply.code(400).send(errorBody('COOKIE_DOMAIN_NOT_ALLOWED', 'Cookie domain is not allowed by this adapter'));
    }
    const session = await sessions.put(params.data.id, body.data.adapterId, body.data.cookies);
    return reply.send({ id: session.id, adapterId: session.adapterId, updatedAt: session.updatedAt });
  });

  app.get('/v1/sessions', async () => ({
    sessions: (await sessions.list()).map(describeSession)
  }));

  /**
   * Live view of the concurrency pool: who is busy, what each balance is, and
   * which accounts are out of credits.
   */
  app.get('/v1/accounts', async (request) => {
    const query = request.query as { refresh?: string; adapterId?: string };
    const accounts = await accountPool.snapshot({
      refresh: query.refresh !== 'false',
      adapterId: query.adapterId
    });

    for (const account of accounts) {
      if (account.exhausted) exhaustedAccounts.set(account.sessionId, account);
      else exhaustedAccounts.delete(account.sessionId);
    }

    return {
      totalCredits: accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0),
      idle: accounts.filter((a) => !a.busy && !a.depleted).length,
      busy: accounts.filter((a) => a.busy).length,
      exhaustedSessionIds: [...exhaustedAccounts.keys()],
      accounts
    };
  });

  app.get('/v1/sessions/:id/credits', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(zodError(params.error));

    const session = await sessions.get(params.data.id);
    if (!session) {
      return reply.code(404).send(errorBody('SESSION_NOT_FOUND', 'Unknown session'));
    }

    const adapter = adapters.get(session.adapterId);
    if (!adapter) {
      return reply.code(400).send(errorBody('ADAPTER_NOT_FOUND', 'Unknown adapter'));
    }
    if (!adapter.getCredits && !adapter.getCreditsFromCookies) {
      return reply.code(400).send(errorBody('CREDITS_NOT_SUPPORTED', 'Adapter does not support credit queries'));
    }

    try {
      return reply.send({
        ...describeSession(session),
        balance: await loadCredits(session, adapter)
      });
    } catch (error) {
      request.log.warn({ err: error }, 'Credit query failed');
      const message = error instanceof Error ? error.message : 'Unknown credit query error';
      return reply.code(502).send(errorBody('CREDIT_QUERY_FAILED', message));
    }
  });

  /** Balances for every stored session, so multi-account setups need one call. */
  app.get('/v1/credits', async () => {
    const stored = await sessions.list();
    const accounts: SessionCredits[] = await Promise.all(stored.map(async (session) => {
      const adapter = adapters.get(session.adapterId);
      if (!adapter?.getCredits && !adapter?.getCreditsFromCookies) {
        return { ...describeSession(session), error: 'CREDITS_NOT_SUPPORTED' };
      }
      try {
        return { ...describeSession(session), balance: await loadCredits(session, adapter) };
      } catch (error) {
        app.log.warn({ err: error, sessionId: session.id }, 'Credit query failed');
        return {
          ...describeSession(session),
          error: error instanceof Error ? error.message : 'Unknown credit query error'
        };
      }
    }));

    return {
      totalCredits: accounts.reduce((sum, account) => sum + (account.balance?.totalCredits ?? 0), 0),
      accounts
    };
  });

  app.get('/v1/jobs/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send(zodError(params.error));
    if (comfy?.store.get(params.data.id)) return reply.send(comfy.publicJob(comfy.requestResultAvailability(params.data.id)));
    const job = jobs.get(params.data.id);
    if (!job || gateway && !gateway.hasJob(job.id)) {
      return reply.code(404).send(errorBody(
        'JOB_NOT_FOUND',
        `Unknown job (finished jobs are kept for ${config.jobRetentionDays} days)`
      ));
    }
    if (gateway) {
      await runner.resumeGatewayQuery(job.id);
      return reply.send(projectGatewayJob(jobs.get(job.id)!));
    }
    return reply.send(job);
  });

  /** Recent jobs, newest first — for finding work whose id was lost. */
  app.get('/v1/jobs', async (request, reply) => {
    const query = listJobsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send(zodError(query.error));
    const status = query.data.status as JobStatus | undefined;
    const legacy = jobs.list({ status }).filter(job => !gateway || gateway.hasJob(job.id)).map(job => gateway ? projectGatewayJob(job) : job);
    const workflow = comfy?.store.list(comfy.options.owner, status).map(job => comfy.publicJob(job)) ?? [];
    const all = [...legacy, ...workflow].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return reply.send({ total: all.length, jobs: all.slice(0, query.data.limit) });
  });

if (comfy) {
app.get('/v1/jobs/:id/events', async (request, reply) => {
const job = comfy.get((request.params as { id: string }).id);
const parsed = comfyEventQuerySchema.safeParse(request.query);
if (!parsed.success) return reply.code(400).send(errorBody('INVALID_INPUT', 'Invalid event cursor'));
const events = comfy.store.events.list({ jobId: job.id, ...parsed.data });
return reply.send({ events, nextAfter: events.at(-1)?.sequence ?? parsed.data.after });
});
app.post('/v1/jobs/:id/inputs', async (request, reply) => {
const parsed = comfyInputsSchema.safeParse(request.body);
if (!parsed.success) return reply.code(400).send(errorBody('INVALID_INPUT', 'Invalid upload acknowledgement'));
return reply.send(comfy.publicJob(comfy.completeInputs((request.params as { id: string }).id, parsed.data.inputs)));
});
app.post('/v1/jobs/:id/collected', async (request, reply) => {
return reply.send(comfy.publicJob(comfy.acknowledgeCollected((request.params as { id: string }).id)));
});
app.get('/v1/jobs/:id/result', async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = comfy.get(id);
      if (job.stage !== 'succeeded' || job.cancel_requested || !job.result) return reply.code(409).send(errorBody('COMFY_RESULT_UNAVAILABLE', 'Result is not durably available'));
      if ((JSON.parse(job.input) as { transport?: string }).transport === 'direct') return reply.code(409).send(errorBody('COMFY_DIRECT_RESULT', 'Download result.videoUrl directly from the registered GPU instance'));
      const result = JSON.parse(job.result) as { hash: string; size: number };
      const stream = await comfy.options.results.read(result);
      if (!stream) return reply.code(404).send(errorBody('COMFY_RESULT_UNAVAILABLE', 'Result is unavailable'));
      return reply.type('video/mp4').header('Content-Length', result.size).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(stream);
    });
    app.post('/v1/jobs/:id/cancel', async (request, reply) => {
      const job = comfy.cancel((request.params as { id: string }).id);
      return reply.send({ ...comfy.publicJob(job), remoteStopped: false });
    });
    app.post('/v1/jobs/:id/reconcile', async (request, reply) => {
      const { id } = request.params as { id: string };
      await comfy.reconcile(id);
      return reply.send(comfy.publicJob(comfy.get(id)));
    });
  }

  // Existing routes/wire shape; only Miora input boundaries gain token streaming.
  await app.register(async mioraRequests => {
    mioraRequests.removeContentTypeParser('application/json');
    mioraRequests.addContentTypeParser('application/json', (request, payload, done) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      void readMioraRequestJson(payload, { signal:controller.signal }).then(parsed => {
        const value = parsed.value as { adapterId?:unknown } | null;
        if (request.url.split('?')[0] === '/v1/jobs' && value?.adapterId !== 'miora-v1' && parsed.bytes > 2 * 1024 * 1024) {
          done(new SystemError(413, 'FST_ERR_CTP_BODY_TOO_LARGE', 'Request body is too large'));
        } else done(null, parsed.value);
      }, error => done(error)).finally(() => request.raw.removeListener('aborted', abort));
    });

    mioraRequests.post('/v1/upload-intents/staged', async (request, reply) => {
      if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
      const parsed = stagedUploadIntentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(zodError(parsed.error));
      const existing = uploadIntents.findByIdempotencyKey(parsed.data.idempotencyKey);
      const candidates = existing ? [] : await intentAccounts();
      const estimate = mioraEstimatedVideoCredits(parsed.data.options, { model:config.mioraVideo.model, durationSeconds:MIORA_UPLOAD_INTENT_FALLBACK_DURATION_SECONDS });
      try {
        const created = uploadIntents.createStaged(parsed.data.idempotencyKey,
          candidates.map(account => ({ accountId:account.sessionId, credits:account.availableCredits ?? account.credits, activeJobs:account.activeJobs })),
          estimate, parsed.data.options, parsed.data.assetCount);
        return reply.code(created.created ? 201 : 200).send(uploadIntents.summary(created.id));
      } catch (error) {
        if (error instanceof SystemError && ['INSUFFICIENT_CREDITS','ACCOUNT_BALANCE_UNAVAILABLE'].includes(error.code)) {
          return reply.code(error.statusCode).send({ error:{ code:error.code, scope:error.code === 'INSUFFICIENT_CREDITS' ? 'pool' : 'task', retryable:error.code === 'ACCOUNT_BALANCE_UNAVAILABLE', message:error.message } });
        }
        throw error;
      }
    });

    mioraRequests.post('/v1/upload-intents', async (request, reply) => {
      if (!uploadIntents) return reply.code(404).send(errorBody('LEGACY_API_DISABLED', 'Video upload intents are disabled'));
      const parsed = uploadIntentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(zodError(parsed.error));
      const existing = uploadIntents.findByIdempotencyKey(parsed.data.idempotencyKey);
      if (existing) {
        uploadIntents.resume(existing, parsed.data.assets);
        resumePublicImports(existing);
        return reply.send(await signedPendingItems(existing));
      }
      const estimate = mioraEstimatedVideoCredits(parsed.data.options, {
        model: config.mioraVideo.model,
        durationSeconds: MIORA_UPLOAD_INTENT_FALLBACK_DURATION_SECONDS
      });
      const candidates = await intentAccounts();
      let created: ReturnType<MioraUploadIntentStore['createReserved']>;
      try {
        created = uploadIntents.createReserved(
          parsed.data.idempotencyKey,
          candidates.map(account => ({
            accountId: account.sessionId,
            credits: account.availableCredits ?? account.credits,
            activeJobs: account.activeJobs
          })),
          estimate,
          parsed.data.options,
          parsed.data.assets
        );
      } catch (error) {
        if (error instanceof SystemError && (error.code === 'INSUFFICIENT_CREDITS' || error.code === 'ACCOUNT_BALANCE_UNAVAILABLE')) {
          return reply.code(error.statusCode).send({ error: {
            code: error.code,
            scope: error.code === 'INSUFFICIENT_CREDITS' ? 'pool' : 'task',
            retryable: error.code === 'ACCOUNT_BALANCE_UNAVAILABLE',
            message: error.message
          } });
        }
        throw error;
      }
      if (!created.created) uploadIntents.resume(created.id, parsed.data.assets);
      resumePublicImports(created.id);
      return reply.code(created.created ? 201 : 200).send(await signedPendingItems(created.id));
    });

    mioraRequests.post('/v1/jobs', async (request, reply) => {
      if ((request.body as { adapterId?: unknown } | null)?.adapterId === 'comfyui-v1') {
        if (!comfy) return reply.code(503).send(errorBody('COMFY_POOL_DISABLED', 'ComfyUI pool is not configured'));
        const input = comfyJobSchema.safeParse(request.body);
        if (!input.success) return reply.code(400).send(zodError(input.error));
        const accepted = comfy.submit(input.data);
        return reply.code(accepted.created ? 202 : 200).send({ jobId: accepted.job.id,
          status: comfy.publicJob(accepted.job).status, statusUrl: `/v1/jobs/${accepted.job.id}` });
      }
      const parsed = createJobSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(zodError(parsed.error));

      const requestedSessionId = 'sessionId' in parsed.data ? parsed.data.sessionId : undefined;
      const requestedAssetId = 'assetId' in parsed.data ? parsed.data.assetId : '';
      const requestedAdditionalAssetIds = 'assetIds' in parsed.data ? parsed.data.assetIds ?? [] : [];
      if (gateway && (parsed.data.adapterId !== 'miora-v1' || requestedSessionId !== undefined)) {
        return reply.code(400).send(errorBody('GATEWAY_INPUT_INVALID', 'The video gateway accepts Miora jobs and selects enabled managed accounts automatically'));
      }

      const adapter = adapters.get(parsed.data.adapterId);
      if (!adapter) {
        return reply.code(400).send(errorBody('ADAPTER_NOT_FOUND', 'Unknown adapter'));
      }
      // Kept whole: the adapter decides how many its provider takes.
      const uploadIntentId = 'uploadIntentId' in parsed.data ? parsed.data.uploadIntentId : undefined;
      const requestedAssetIds = uploadIntentId ? [] : Array.from(new Set([
        requestedAssetId,
        ...requestedAdditionalAssetIds
      ]));
      const missingAssetId = requestedAssetIds.find((assetId) => !assets.get(assetId) || gateway && !gateway.hasAsset(assetId));
      if (missingAssetId !== undefined) {
        return reply.code(400).send(errorBody('ASSET_NOT_FOUND', `Unknown asset: ${missingAssetId}`));
      }

      // Fail fast rather than queueing work no account can pay for.
      let gatewaySessionId: string | undefined;
      let preparedReferences: Array<{key:string;kind:'image'|'video'|'audio'}> | undefined;
      let durableGatewayJobId: string | undefined;
      if (uploadIntentId) {
        if (!uploadIntents || !gateway) return reply.code(400).send(errorBody('UPLOAD_INTENTS_UNAVAILABLE', 'Upload intents are unavailable'));
        durableGatewayJobId = `${gatewayJobIdPrefix}${uploadIntentId}`;
        const prepared = uploadIntents.readyForJob(uploadIntentId, durableGatewayJobId);
        gatewaySessionId = prepared.accountId;
        preparedReferences = prepared.references;
        const existing = jobs.get(prepared.jobId);
        if (prepared.consumed) {
          if (!existing) return reply.code(410).send(errorBody('JOB_RESULT_EXPIRED', 'This upload intent was already submitted and its retained job result has expired'));
          await jobs.flushOrThrow(existing.id); gateway.ownJob(existing.id);
          if (existing.status === 'queued') runner.submit(existing);
          return reply.code(202).send({ jobId: existing.id, status: existing.status, statusUrl: `/v1/jobs/${existing.id}` });
        }
        const estimatedCredits = mioraEstimatedVideoCredits(parsed.data.options, {
          model: config.mioraVideo.model,
          durationSeconds: config.mioraVideo.duration
        });
        if (estimatedCredits !== undefined) {
          const candidates = (await accountPool.snapshot({ loadCredits: true, adapterId: 'miora-v1' }))
            .filter(account => {
              const row = options.managedChannels!.row(account.sessionId);
              return !!row?.enabled && !row.archived_at && !account.exhausted;
            });
          const pinned = candidates.find(account => account.sessionId === gatewaySessionId);
          const pinnedCredits = pinned?.availableCredits ?? pinned?.credits;
          if (pinnedCredits === undefined) return reply.code(503).send({ error: {
            code:'ACCOUNT_BALANCE_UNAVAILABLE', scope:'task', retryable:true,
            message:'The upload intent account balance could not be confirmed'
          } });
          const pinnedAvailable = pinnedCredits - uploadIntents.reservedCredits(gatewaySessionId, uploadIntentId);
          if (pinnedAvailable < estimatedCredits) {
            const poolCanPay = candidates.some(account => {
              const credits = account.availableCredits ?? account.credits;
              return credits !== undefined
                && credits - uploadIntents.reservedCredits(account.sessionId, uploadIntentId) >= estimatedCredits;
            });
            const poolUnknown = candidates.some(account => (account.availableCredits ?? account.credits) === undefined);
            if (!poolCanPay && poolUnknown) return reply.code(503).send({ error: {
              code:'ACCOUNT_BALANCE_UNAVAILABLE', scope:'task', retryable:true,
              message:'The Miora account pool balance could not be confirmed'
            } });
            return reply.code(409).send({ error: {
              code: poolCanPay ? 'ACCOUNT_INSUFFICIENT_CREDITS' : 'INSUFFICIENT_CREDITS',
              scope: poolCanPay ? 'account' : 'pool',
              retryable: poolCanPay,
              message: poolCanPay
                ? 'The upload intent account cannot pay for this job; create a new upload intent with the job options'
                : 'No enabled account has enough credits for this job'
            } });
          }
        }
      }
      if (adapter.runWithoutBrowser || requestedSessionId) {
        const candidates = (await accountPool.snapshot({ adapterId: parsed.data.adapterId }))
          .filter((a) => !(requestedSessionId || gatewaySessionId) || a.sessionId === (requestedSessionId || gatewaySessionId))
          .filter((a) => {
            if (!gateway) return true;
            const account = options.managedChannels!.row(a.sessionId);
            return !!account?.enabled && !account.archived_at;
          });

        if (!candidates.length) {
          return reply.code(400).send(errorBody(
            'NO_ACCOUNTS_AVAILABLE',
            requestedSessionId
              ? `Session ${requestedSessionId} is not a usable ${parsed.data.adapterId} account`
              : `No ${parsed.data.adapterId} account is configured`
          ));
        }
        if (candidates.every((a) => a.exhausted)) {
          return reply.code(409).send({
            error: {
              code: 'INSUFFICIENT_CREDITS',
              message: 'Every account is out of credits',
              ...(gateway ? {} : { accounts: candidates })
            }
          });
        }
        if (gateway && !gatewaySessionId) gatewaySessionId = candidates.filter(account => !account.exhausted)
          .sort((left, right) => accountPool.activeJobs(left.sessionId) - accountPool.activeJobs(right.sessionId))[0]!.sessionId;
      }

      const jobInput = { ...parsed.data, assetId: uploadIntentId ? '' : requestedAssetId, assetIds: requestedAssetIds,
        ...(preparedReferences ? { preparedReferences } : {}), ...(gatewaySessionId ? { sessionId: gatewaySessionId } : {}) };
      const job = jobs.create(jobInput, gateway ? durableGatewayJobId ?? `${gatewayJobIdPrefix}${randomUUID()}` : undefined);
      if (gateway) {
        await jobs.flushOrThrow(job.id);
        gateway.ownJob(job.id);
        if (uploadIntentId) uploadIntents!.consume(uploadIntentId, job.id);
      }
      runner.submit(job);
      return reply.code(202).send({
        jobId: job.id,
        status: job.status,
        statusUrl: `/v1/jobs/${job.id}`
      });
    });
  });

  app.addHook('onClose', async () => {
    try {
    await comfy?.close();
    mioraTransfers.close();
    await Promise.allSettled(importRuns.values());
    tokenWatcher.stop();
    dreamMakerWatcher.stop();
    higgsfieldWatcher.stop();
    mioraWatcher.stop();
    mioraImportWatcher.stop();
    clearInterval(dreamMakerTokenTimer);
    clearInterval(mioraTokenTimer);
    if(managedAccountTimer)clearInterval(managedAccountTimer);
    await managedAccountOperations?.close();
    clearInterval(pruneTimer);
    await browsers.close();
    await jobs.flush();
    } finally { mioraDiagnosticSink.flush(); }
  });
  app.decorate('channelRuntime', { jobs, runner, assets, accountPool, sessions, accountOperations:managedAccountOperations, comfy });
  return app;
}

function publicAsset(asset: { id: string; originalName: string; mimeType: string; size: number; createdAt: string }) {
  return { id: asset.id, originalName: asset.originalName, mimeType: asset.mimeType, size: asset.size, createdAt: asset.createdAt };
}

interface SessionSummary {
  sessionId: string;
  adapterId: string;
  account?: ProviderAccount;
  updatedAt: string;
}

interface SessionCredits extends SessionSummary {
  balance?: CreditBalance;
  error?: string;
}

/** Proxy URLs carry credentials, and this one goes into the log at every boot. */
function maskProxyUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.username ? '***@' : ''}${url.host}`;
  } catch {
    return 'invalid';
  }
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function zodError(error: z.ZodError) {
  return validationBody(error.issues);
}

function validationError(...results: Array<z.ZodSafeParseResult<unknown>>) {
  return validationBody(results.flatMap((result) => result.success ? [] : result.error.issues));
}

/**
 * Callers only ever show `message`, so it has to name the offending field —
 * a bare "Invalid request" sends people digging through logs. `issues` is
 * still there in full for anyone who wants it.
 */
function validationBody(issues: z.core.$ZodIssue[]) {
  const reason = describeIssues(issues);
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: reason ? `Invalid request: ${reason}` : 'Invalid request',
      issues
    }
  };
}

function describeIssues(issues: z.core.$ZodIssue[]): string {
  // `createJobSchema` is a union (one branch per adapter), so the real reason
  // sits inside the branch that matched the adapter, not at the top level.
  const flattened = flattenIssues(issues);
  const relevant = flattened.filter((issue) => issue.path !== 'adapterId');
  return (relevant.length ? relevant : flattened)
    .slice(0, 3)
    .map((issue) => `${issue.path || 'body'} — ${issue.message}`)
    .join('; ');
}

function flattenIssues(issues: readonly z.core.$ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.flatMap((issue) => {
    const nested = (issue as { errors?: z.core.$ZodIssue[][] }).errors;
    if (issue.code === 'invalid_union' && Array.isArray(nested)) {
      return nested.flatMap((group) => flattenIssues(group));
    }
    return [{ path: issue.path.join('.'), message: issue.message }];
  });
}

function cookieAllowed(
  cookie: { domain?: string; url?: string },
  allowedDomains: readonly string[]
): boolean {
  let hostname: string | undefined;
  if (cookie.url) {
    try {
      hostname = new URL(cookie.url).hostname;
    } catch {
      return false;
    }
  } else if (cookie.domain) {
    hostname = cookie.domain.replace(/^\./, '');
  }
  if (!hostname) return false;
  return allowedDomains.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/**
 * The bytes have to agree with the declared type, so a caller cannot smuggle
 * one kind of file in under another's name. Containers are checked at their own
 * landmark: MP4 and MOV carry an `ftyp` box a few bytes in, WebM is Matroska's
 * EBML header, and the image formats have their usual magic numbers.
 */
function matchesAssetSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  if (mimeType === 'video/webm') {
    return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/gif') {
    const header = buffer.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

const demoPageHtml = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>Browser Automation Demo</title></head>
  <body>
    <main>
      <label>文字内容 <textarea id="text"></textarea></label>
      <label>上传图片 <input id="image" type="file" accept="image/*"></label>
      <button id="submit" type="button">提交查询</button>
      <section id="result" hidden></section>
    </main>
    <script>
      document.querySelector('#submit').addEventListener('click', () => {
        const text = document.querySelector('#text').value;
        const file = document.querySelector('#image').files[0];
        window.setTimeout(() => {
          const result = document.querySelector('#result');
          result.textContent = '处理完成：' + text + ' / ' + (file ? file.name : '无文件');
          result.dataset.text = text;
          result.dataset.fileName = file ? file.name : '';
          result.dataset.ready = 'true';
          result.hidden = false;
        }, 200);
      });
    </script>
  </body>
</html>`;
