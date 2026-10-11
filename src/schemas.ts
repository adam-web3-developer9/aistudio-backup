import { z } from 'zod';

/** MiniMax H3 through Hailuo: one model, one reference mode, a fixed resolution pair. */
const hailuoJobOptionsSchema = z.object({
  modelId: z.literal('hailuo3.0-i2v').optional(),
  resolution: z.enum(['768', '1440']).optional(),
  durationSeconds: z.int().min(4).max(15).optional(),
  aspectRatio: z.enum(['Auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).optional(),
  referenceMode: z.literal('all-reference').optional(),
  frameType: z.literal(4).optional(),
  quantity: z.literal(1).optional(),
  useOriginPrompt: z.boolean().optional()
});

/**
 * DreamMaker's limits are DreamMaker's to enforce.
 *
 * Its model list, resolution tiers, duration ranges and reference-image counts
 * differ per model and change without us, and this service is a pass-through:
 * a value we reject here is a job the platform might well have accepted, and
 * the caller gets `Invalid request` instead of the platform's own reasoning.
 * So only the shape is checked — the platform answers for the values.
 */
const dreamMakerJobOptionsSchema = z.object({
  modelId: z.string().min(1).max(200).optional(),
  mode: z.string().min(1).max(50).optional(),
  resolution: z.string().min(1).max(20).optional(),
  durationSeconds: z.int().min(1).optional(),
  aspectRatio: z.string().min(1).max(20).optional(),
  quantity: z.int().min(1).optional()
});

/**
 * Higgsfield's limits are Higgsfield's to enforce, the same reasoning as
 * DreamMaker's above: the generator list, resolution tiers and duration ranges
 * are per model and change without us.
 *
 * `modelId` is the platform's model id (`seedance_2_5`, `minimax_hailuo`, …).
 * `mode` is the generation mode, and it is an enum here because it is the one
 * option that changes what a job costs rather than what it looks like:
 * `video_edit` edits a reference video and is billed by **that video's own
 * duration**, ignoring `durationSeconds` and `aspectRatio` entirely.
 */
const higgsfieldJobOptionsSchema = z.object({
  modelId: z.string().min(1).max(200).optional(),
  mode: z.enum(['t2v', 'omni_reference', 'video_edit', 'video_extension']).optional(),
  resolution: z.string().min(1).max(20).optional(),
  durationSeconds: z.int().min(1).optional(),
  aspectRatio: z.string().min(1).max(20).optional(),
  quantity: z.int().min(1).optional()
});

/**
 * Miora is a pure pass-through channel: no length, range or count limit of any
 * kind is enforced here — whatever the caller sends goes to the platform, and the
 * platform's own answer is what the caller gets back. Only the field types are
 * read so the adapter can find them.
 */
const mioraJobOptionsSchema = z.looseObject({
  modelId: z.string().optional(),
  resolution: z.string().optional(),
  durationSeconds: z.number().optional(),
  aspectRatio: z.string().optional(),
  quantity: z.number().optional()
});

/**
 * Every bound here is the provider's own, never one this service invents.
 *
 * - prompt: Hailuo's create page caps at 7000 characters, DreamMaker's API
 *   answers `String should have at most 20000 characters`.
 * - reference assets: Hailuo takes 9 (its adapter trims to that); DreamMaker's
 *   limit is per model, so the count is left to it. The 200 here is only a
 *   guard against a runaway payload, far above anything a model accepts.
 *
 * Capping tighter than the provider would reject jobs it was happy to run.
 */
function jobFields(limits: { promptChars: number; assetIds: number }) {
  return {
    text: z.string().min(1).max(limits.promptChars),
    assetId: z.string().min(1).max(200),
    assetIds: z.array(z.string().min(1).max(200)).max(limits.assetIds).optional(),
    sessionId: z.string().min(1).max(200).optional()
  };
}

/**
 * Which option set applies is decided by the adapter. An adapter without one of
 * its own (the demo) takes no options at all rather than borrowing another
 * adapter's.
 */
export const createJobSchema = z.union([
  z.object({
    adapterId: z.literal('hailuo-v1'),
    ...jobFields({ promptChars: 7_000, assetIds: 9 }),
    options: hailuoJobOptionsSchema.optional()
  }),
  z.object({
    adapterId: z.literal('dreammaker-v1'),
    ...jobFields({ promptChars: 20_000, assetIds: 200 }),
    options: dreamMakerJobOptionsSchema.optional()
  }),
  z.object({
    adapterId: z.literal('higgsfield-v1'),
    ...jobFields({ promptChars: 20_000, assetIds: 200 }),
    options: higgsfieldJobOptionsSchema.optional()
  }),
  z.object({
    adapterId: z.literal('miora-v1'),
    // No limits: prompt length, asset count and every option go through as sent.
    text: z.string(),
    assetId: z.string(),
    assetIds: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
    options: mioraJobOptionsSchema.optional()
  }),
  z.object({
    adapterId: z.string().min(1).max(100),
    ...jobFields({ promptChars: 7_000, assetIds: 9 }),
    options: z.undefined()
  })
]);

const cookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  url: z.url().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional()
}).refine((cookie) => Boolean(cookie.url || cookie.domain), {
  message: 'Cookie requires either url or domain'
});

export const putSessionSchema = z.object({
  adapterId: z.string().min(1).max(100),
  cookies: z.array(cookieSchema).max(200)
});
