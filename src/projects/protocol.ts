import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export type EntityType = 'draft' | 'episode' | 'asset' | 'scene' | 'shot' | 'canvas';
export interface ProjectPrincipal { id: string; sessionId: string; emailVerified: boolean; cloudEligible: boolean; sharingEligible: boolean; adminRole?: 'superadmin' | 'operator' | 'readonly' | null }
export interface ProjectRuntime {
  db: Database.Database;
  authenticate(request: FastifyRequest): Promise<ProjectPrincipal | null>;
  assertRequestOrigin?(request: FastifyRequest): void;
  assertPrincipalCurrent?(principal: Pick<ProjectPrincipal, 'id' | 'sessionId'>): ProjectPrincipal;
  store?: { getIdentity(id: string): unknown; getIdentityByEmail?(email: string): unknown; audit(event: { actorId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> }): unknown };
}
export class ProjectError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
export const entityTypeSchema = z.enum(['draft', 'episode', 'asset', 'scene', 'shot', 'canvas']);
const fieldsSchema = z.record(z.string().min(1).max(100), z.unknown());
const versionsSchema = z.record(z.string(), z.number().int().nonnegative());
export const memberSchema = z.object({ userId: idSchema, role: z.enum(['editor', 'viewer']) }).strict();
export const snapshotInputSchema = z.object({ entities: z.array(z.object({ type: entityTypeSchema, id: idSchema, fields: fieldsSchema }).strict()).max(20000), collections: z.record(idSchema, z.array(idSchema).max(20000)).default({}) }).strict();
const update = z.object({ kind: z.literal('update'), type: entityTypeSchema, id: idSchema, set: fieldsSchema.optional(), unset: z.array(z.string().min(1).max(100)).max(200).optional(), expected: versionsSchema }).strict();
const insert = z.object({ kind: z.literal('insert'), type: entityTypeSchema, id: idSchema, fields: fieldsSchema, collection: idSchema.optional(), expectedCollectionVersion: z.number().int().nonnegative().optional() }).strict();
const restore = z.object({ kind: z.literal('restore'), type: entityTypeSchema, id: idSchema, fields: fieldsSchema, expectedDeletedRevision: z.number().int().positive(), collection: idSchema.optional(), expectedCollectionVersion: z.number().int().nonnegative().optional() }).strict();
const remove = z.object({ kind: z.literal('delete'), type: entityTypeSchema, id: idSchema, collection: idSchema.optional(), expectedCollectionVersion: z.number().int().nonnegative().optional(), expectedVersions: versionsSchema }).strict();
const reorder = z.object({ kind: z.literal('reorder'), collection: idSchema, ids: z.array(idSchema).max(20000), expectedCollectionVersion: z.number().int().nonnegative() }).strict();
const candidate = z.object({ kind: z.literal('appendCandidate'), assetId: idSchema.optional(), type: entityTypeSchema.optional(), id: idSchema.optional(), field: z.string().min(1).max(250).optional(), candidateId: idSchema, value: fieldsSchema }).strict().refine(value => Boolean(value.assetId) !== Boolean(value.type && value.id) && (Boolean(value.assetId) || Boolean(value.type && value.id)), 'Provide assetId or type/id');
export const commandSchema = z.object({ commandId: idSchema, generation: z.number().int().positive(), operations: z.array(z.discriminatedUnion('kind', [update, insert, remove, restore, reorder, candidate])).min(1).max(200) }).strict();
export type Command = z.infer<typeof commandSchema>;
export type SnapshotInput = z.infer<typeof snapshotInputSchema>;
export type Member = z.infer<typeof memberSchema>;
export interface Entity { type: EntityType; id: string; fields: Record<string, unknown>; versions: Record<string, number>; deleted: boolean; deletedRevision?: number }
export interface Snapshot { projectId: string; ownerId: string; generation: number; revision: number; entities: Entity[]; collections: Record<string, { ids: string[]; version: number }>; members: { userId: string; role: string }[] }

const forbiddenKeys = /^(?:__proto__|prototype|constructor|apikey|apikeys|accesskey|cardkey|secretkey|privatekey|authorization|session|sessionid|sessions|deviceid|latest|queue|queues|taskqueue|taskqueues|tasks|pendingjobs|runningjobs|outbox|localpath|filepath|absolutepath|relativepath|mediarelativepath|localid|storageprovider|path|localrevision|scoperevision|revision|devicepath|base64|imagebase64|audiobase64|videobase64|checkpoint|drivercheckpoint|inputsnapshot|outputsnapshot|runtimesnapshot|batchrun|taskplan|taskchain)$/i;
export function isPrivateWireKey(key: string): boolean {
  return forbiddenKeys.test(key) || forbiddenKeys.test(key.replace(/[_-]/g, '')) || /(?:token|password|secret|credential|cookie)/i.test(key);
}

export function assertSafeWire(value: unknown, depth = 0): void {
  if (depth > 30) throw new ProjectError(400, 'INVALID_WIRE', 'Payload nesting is too deep');
  if (typeof value === 'string') {
    if (/^data:(?:image|video|audio|application)\//i.test(value)) throw new ProjectError(400,'INLINE_MEDIA_FORBIDDEN','Upload media bytes through the private media endpoint');
    if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/[^\/]|file:|local-media:|aistudio-media:)/.test(value)) throw new ProjectError(400, 'PRIVATE_LOCAL_PATH', 'Local paths cannot be uploaded');
  } else if (Array.isArray(value)) { for (const item of value) assertSafeWire(item, depth + 1); }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('/') && key.split('/').some(part => isPrivateWireKey(part.replace(/~1/g, '/').replace(/~0/g, '~')))) throw new ProjectError(400, 'INVALID_WIRE', 'Private field path cannot be uploaded');
      const decodedKey = key.startsWith('/') ? key.split('/').at(-1)!.replace(/~1/g, '/').replace(/~0/g, '~') : key;
      if (decodedKey === 'latest' || (decodedKey === 'origin' && (item === 'task' || item === 'workflow'))) throw new ProjectError(400, 'INVALID_WIRE', 'Reserved field cannot be uploaded');
      if (isPrivateWireKey(key) || key === 'latest' || (key === 'origin' && (item === 'task' || item === 'workflow'))) throw new ProjectError(400, 'INVALID_WIRE', `Field ${key} cannot be uploaded`);
      assertSafeWire(item, depth + 1);
    }
  }
}
export function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(item) ?? 'null';
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export async function authenticate(runtime: ProjectRuntime, request: FastifyRequest): Promise<ProjectPrincipal> {
  const principal = await runtime.authenticate(request);
  if (!principal) throw new ProjectError(401, 'UNAUTHENTICATED', 'Account session required');
  return principal;
}
export function requireCloud(principal: ProjectPrincipal): void {
  if (!principal.emailVerified || !principal.cloudEligible || !principal.sharingEligible) throw new ProjectError(403, 'SHARING_INELIGIBLE', 'Verified active account with sharing eligibility required');
}
export function requireAdmin(principal: ProjectPrincipal, mutate = false): void {
  if (!principal.adminRole || (mutate && principal.adminRole === 'readonly')) throw new ProjectError(403, 'ADMIN_FORBIDDEN', 'Administrator permission required');
}
export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request payload' } });
  if (error instanceof ProjectError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, ...error.details });
  throw error;
}
