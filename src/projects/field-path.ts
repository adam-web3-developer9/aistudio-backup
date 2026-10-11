import { ProjectError, type Entity } from './protocol.js';
export function pointer(key: string): string {
  if (!key.startsWith('/')) return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  if (/~(?![01])/u.test(key)) throw new ProjectError(400, 'INVALID_FIELD_PATH', 'Invalid JSON pointer');
  return key;
}
export function pathParts(key: string): string[] {
  const parts = pointer(key).slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(part => !part || /^(?:__proto__|prototype|constructor)$/.test(part))) throw new ProjectError(400, 'INVALID_FIELD_PATH', 'Unsafe field path');
  return parts;
}
export function fieldVersion(entity: Entity, key: string): number {
  const path = pointer(key);
  return Math.max(0, ...Object.entries(entity.versions).filter(([versionKey]) => { const versionPath = pointer(versionKey); return path === versionPath || path.startsWith(`${versionPath}/`) || versionPath.startsWith(`${path}/`); }).map(([, version]) => version));
}
function child(object: Record<string, unknown> | unknown[], key: string, create: boolean): unknown {
  if (Array.isArray(object)) {
    const selector = /^@(id|boardId|candidateId)=(.+)$/.exec(key);
    if (!selector) throw new ProjectError(400, 'ARRAY_INDEX_FORBIDDEN', 'Use stable ID selectors for arrays');
    const found = object.find(item => item && typeof item === 'object' && String((item as Record<string, unknown>)[selector[1]!]) === selector[2]);
    if (!found) throw new ProjectError(409, 'STABLE_ID_MISSING', 'Array entity with stable ID does not exist');
    return found;
  }
  if (object[key] === undefined && create) object[key] = {};
  return object[key];
}
export function readField(fields: Record<string, unknown>, key: string): unknown {
  let object: unknown = fields;
  for (const part of pathParts(key)) {
    if (!object || typeof object !== 'object') return undefined;
    object = child(object as Record<string, unknown> | unknown[], part, false);
  }
  return object;
}
export function mutateField(fields: Record<string, unknown>, key: string, value: unknown, unset = false): void {
  const parts = pathParts(key); let object: unknown = fields;
  for (const part of parts.slice(0, -1)) {
    if (!object || typeof object !== 'object') throw new ProjectError(400, 'INVALID_FIELD_PATH', 'Field path crosses a scalar');
    object = child(object as Record<string, unknown> | unknown[], part, true);
  }
  if (!object || typeof object !== 'object') throw new ProjectError(400, 'INVALID_FIELD_PATH', 'Field path crosses a scalar');
  if (Array.isArray(object)) throw new ProjectError(400, 'ARRAY_INDEX_FORBIDDEN', 'Array entity replacement requires a structure command');
  const final = parts.at(-1)!;
  if (unset) delete (object as Record<string, unknown>)[final]; else (object as Record<string, unknown>)[final] = value;
}
export const candidateFieldNames = new Set(['candidates', 'imageVariants', 'videoVariants', 'audioVariants', 'videos']);
