import type { BrowserContext } from 'playwright';

export type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** Per-model price list, from the `modelControl` block of the equity response. */
export interface ModelCost {
  modelId: string;
  defaultCost: number;
  /** `type` is the enum the cost table keys on; `value` is the human number (512, 6, ...). */
  resolutions: Array<{ type: number; value: number }>;
  durations: Array<{ type: number; value: number }>;
  costs: Array<{ resolutionType: number; durationType: number; cost: number }>;
}

export interface CreditBalance {
  totalCredits: number;
  breakdown: Array<{
    creditType: number;
    credits: number;
    record: unknown;
  }>;
  /** Absent when the response carried no price list. */
  models?: ModelCost[];
}

/** Who a stored credential belongs to, as far as the credential itself says. */
export interface ProviderAccount {
  userId?: string;
  name?: string;
  expiresAt?: string;
}

/** The name this had while Hailuo was the only channel. */
export type HailuoAccount = ProviderAccount;

export interface AssetRecord {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  adapterId: string;
  cookies: BrowserCookie[];
  updatedAt: string;
}

/**
 * Per-job overrides for the generation parameters. The fields are shared across
 * adapters; which values are legal is per adapter and enforced in `schemas.ts`.
 */
export interface JobOptions {
  /** Hailuo: `hailuo3.0-i2v`. DreamMaker: any `toolKey` from `/api/tool_spec/list`. */
  modelId?: string;
  /** Hailuo: "768" | "1440" (2K). DreamMaker: "480p" | "720p" | "768p" | "1080p" | "2k" | "4k". */
  resolution?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  /** DreamMaker: which inputs the model is given — image2video, allReference, … */
  mode?: string;
  referenceMode?: string;
  frameType?: number;
  quantity?: number;
  /** false lets Hailuo rewrite the prompt before generating. */
  useOriginPrompt?: boolean;
}

export interface CreateJobInput {
  adapterId: string;
  text: string;
  assetId: string;
  assetIds?: string[];
  sessionId?: string;
  options?: JobOptions;
  /** Miora COS objects prepared by a gateway upload intent. Never accepted raw from callers. */
  preparedReferences?: Array<{ key: string; kind: 'image' | 'video' | 'audio' }>;
  uploadIntentId?: string;
}

/**
 * What the adapter has reported so far about a running job. Persisted with the
 * job so a restarted service can pick the render back up instead of losing it.
 */
export interface JobProgress {
  /** Provider-side id of the submitted generation — enough to resume polling. */
  providerJobId?: string;
  batchId?: string;
  /** 0-100 while rendering. */
  percent?: number;
  message?: string;
  referenceImages?: Array<{ fileId: string; url: string }>;
  /**
   * The provider-side file records the generation was submitted with. Kept so a
   * failed render can be resubmitted without uploading again, also after a restart.
   */
  uploadedFiles?: unknown[];
  /** Balance read by the adapter just before submitting. */
  creditsBefore?: number;
  /** How many times the generation has been submitted to the provider (1 = no resubmission yet). */
  renderAttempts?: number;
  /** Set while the service waits to retry a failed step; cleared when the retry starts. */
  retry?: JobRetryState;
  updatedAt: string;
}

/** A retry the service scheduled itself, exposed so callers can show it instead of guessing. */
export interface JobRetryState {
  /** Which step failed: credits, upload, submit, poll, render. */
  step: string;
  /** The try that just failed, 1-based. */
  attempt: number;
  /** First try plus every scheduled retry. */
  maxAttempts: number;
  delayMs: number;
  /** ISO time the next try starts. */
  nextAttemptAt: string;
  /** Failure code of the try that failed, e.g. PROVIDER_RENDER_FAILED. */
  code: string;
  reason: string;
}

export type JobProgressUpdate = Omit<JobProgress, 'updatedAt'>;

export interface JobRecord extends CreateJobInput {
  id: string;
  status: JobStatus;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    /**
     * True when the failure was of a transient kind (network, provider busy,
     * render failed) — the service already retried it and gave up, but a fresh
     * submission may succeed. False means the same input will fail again.
     */
    retryable?: boolean;
    /** Task verdict, distinct from a failed status query or local execution timeout. */
    providerTerminal?: boolean;
    /** How many tries the service made on the failing step before giving up. */
    attempts?: number;
    /** Hailuo's own status code / HTTP status, when there was one. */
    providerCode?: number | string;
    /** Hailuo's own message, untouched. */
    providerMessage?: string;
    /** Per-account detail on INSUFFICIENT_CREDITS and ACCOUNT_BALANCE_UNAVAILABLE. */
    accounts?: unknown;
  };
  progress?: JobProgress;
  /** Balance of the account this job was dispatched to, read just before it ran. */
  creditsBefore?: number;
  createdAt: string;
  /** Set when an account was acquired — queue time sits between this and createdAt. */
  startedAt?: string;
  finishedAt?: string;
}
