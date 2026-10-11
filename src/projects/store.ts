import type Database from 'better-sqlite3';
import { fieldVersion, mutateField, pointer, pathParts, readField, candidateFieldNames } from './field-path.js';
import { ProjectError, assertSafeWire, canonicalHash, requireCloud, type Command, type Entity, type Member, type ProjectPrincipal, type Snapshot, type SnapshotInput } from './protocol.js';

interface ProjectRow { id: string; owner_id: string; shared: number; generation: number; revision: number; snapshot: string }
export class ProjectStore {
  constructor(public readonly db: Database.Database, private readonly principalCurrent?: (principal: ProjectPrincipal) => ProjectPrincipal) {
    db.exec(`CREATE TABLE IF NOT EXISTS shared_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, shared INTEGER NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(project_id,user_id));
      CREATE TABLE IF NOT EXISTS shared_project_receipts (project_id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(project_id,command_id));
      CREATE TABLE IF NOT EXISTS shared_project_share_receipts (project_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,generation INTEGER NOT NULL,response TEXT NOT NULL,PRIMARY KEY(project_id,request_id));
      CREATE TABLE IF NOT EXISTS shared_project_changes (project_id TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL, command_id TEXT NOT NULL, operations TEXT NOT NULL, PRIMARY KEY(project_id,generation,revision));`);
  }
  row(projectId: string): ProjectRow | undefined { return this.db.prepare('SELECT * FROM shared_projects WHERE id=?').get(projectId) as ProjectRow | undefined; }
  access(projectId: string, principal: ProjectPrincipal, write = false, owner = false): ProjectRow {
    principal = this.principalCurrent?.(principal) ?? principal; requireCloud(principal);
    const row = this.row(projectId);
    if (!row || !row.shared) throw new ProjectError(404, 'PROJECT_UNAVAILABLE', 'Shared project unavailable');
    const member = this.db.prepare('SELECT role FROM shared_project_members WHERE project_id=? AND user_id=?').get(projectId, principal.id) as { role: string } | undefined;
    if (!member || (write && member.role === 'viewer') || (owner && row.owner_id !== principal.id)) throw new ProjectError(403, 'PROJECT_FORBIDDEN', 'Project permission denied');
    return row;
  }
  members(projectId: string) { return this.db.prepare('SELECT user_id AS userId,role FROM shared_project_members WHERE project_id=? ORDER BY user_id').all(projectId) as { userId: string; role: string }[]; }
  snapshotFromRow(row: ProjectRow): Snapshot { return { ...JSON.parse(row.snapshot) as Snapshot, projectId: row.id, ownerId: row.owner_id, generation: row.generation, revision: row.revision, members: this.members(row.id) }; }
  snapshot(projectId: string, principal: ProjectPrincipal): Snapshot { return this.snapshotFromRow(this.access(projectId, principal)); }
  generation(row: ProjectRow, generation: number) { if (row.generation !== generation) throw new ProjectError(409, 'GENERATION_MISMATCH', 'Sharing generation changed', { generation: row.generation }); }
  share(projectId: string, principal: ProjectPrincipal, input: SnapshotInput, members: Member[], requestId?: string): Snapshot {
    principal = this.principalCurrent?.(principal) ?? principal; requireCloud(principal); assertSafeWire(input);
    return this.db.transaction(() => {
      const existing = this.row(projectId);
      if (existing && existing.owner_id !== principal.id) throw new ProjectError(403, 'PROJECT_FORBIDDEN', 'Only owner may share this project');
      if (requestId) {
        const receipt = this.db.prepare('SELECT * FROM shared_project_share_receipts WHERE project_id=? AND request_id=?').get(projectId, requestId) as { payload_hash: string;generation: number;response: string } | undefined;
        if (receipt) {
          if (receipt.payload_hash !== canonicalHash({ input, members })) throw new ProjectError(409, 'REQUEST_ID_REUSED', 'Share request ID was reused');
          if (!existing?.shared || existing.generation !== receipt.generation) throw new ProjectError(409, 'GENERATION_MISMATCH', 'Share request was superseded or disabled');
          return JSON.parse(receipt.response) as Snapshot;
        }
      }
      if (existing?.shared) throw new ProjectError(409, 'ALREADY_SHARED', 'Project is already shared');
      const entityKeys = new Set<string>();
      for (const entity of input.entities) { const key = `${entity.type}:${entity.id}`; if (entityKeys.has(key)) throw new ProjectError(400, 'DUPLICATE_ENTITY', 'Duplicate entity ID'); entityKeys.add(key); }
      const entityIds = new Set(input.entities.map(entity => entity.id));
      for (const ids of Object.values(input.collections)) if (new Set(ids).size !== ids.length || ids.some(id => !entityIds.has(id))) throw new ProjectError(400, 'INVALID_COLLECTION', 'Collections require unique existing entity IDs');
      const generation = (existing?.generation ?? 0) + 1;
      const snapshot: Snapshot = { projectId, ownerId: principal.id, generation, revision: 0, entities: input.entities.map(entity => ({ ...entity, versions: Object.fromEntries(Object.keys(entity.fields).map(key => [key, 0])), deleted: false })), collections: Object.fromEntries(Object.entries(input.collections).map(([key, ids]) => [key, { ids, version: 0 }])), members: [] };
      this.db.prepare(`INSERT INTO shared_projects VALUES(?,?,1,?,0,?,?) ON CONFLICT(id) DO UPDATE SET shared=1,generation=excluded.generation,revision=0,snapshot=excluded.snapshot,updated_at=excluded.updated_at`).run(projectId, principal.id, generation, JSON.stringify(snapshot), new Date().toISOString());
      this.cancelRevokedJobs(projectId, true);
      this.replaceMembers(projectId, principal.id, members);
      const confirmed = this.snapshotFromRow(this.row(projectId)!);
      if (requestId) this.db.prepare('INSERT INTO shared_project_share_receipts VALUES(?,?,?,?,?)').run(projectId, requestId, canonicalHash({ input, members }), generation, JSON.stringify(confirmed));
      return confirmed;
    }).immediate();
  }
  cancelRevokedJobs(projectId: string, all = false): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_jobs'").get()) return;
    const memberCondition = all ? '' : " AND actor_id NOT IN (SELECT user_id FROM shared_project_members WHERE project_id=? AND role IN ('owner','editor'))";
    this.db.prepare("UPDATE system_jobs SET status='canceled',fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE project_id=? AND status IN ('queued','running','uncertain')" + memberCondition).run(new Date().toISOString(), projectId, ...(all ? [] : [projectId]));
  }
  replaceMembers(projectId: string, ownerId: string, members: Member[]) {
    if (new Set(members.map(member => member.userId)).size !== members.length) throw new ProjectError(400, 'DUPLICATE_MEMBER', 'Duplicate whitelist member');
    this.db.prepare('DELETE FROM shared_project_members WHERE project_id=?').run(projectId);
    const insert = this.db.prepare('INSERT INTO shared_project_members VALUES(?,?,?)');
    insert.run(projectId, ownerId, 'owner');
    for (const member of members) if (member.userId !== ownerId) insert.run(projectId, member.userId, member.role);
    this.cancelRevokedJobs(projectId);
  }
  setMembers(projectId: string, principal: ProjectPrincipal, members: Member[]) {
    return this.db.transaction(() => { const row = this.access(projectId, principal, true, true); this.replaceMembers(projectId, row.owner_id, members); return this.members(projectId); }).immediate();
  }
  disable(projectId: string, principal: ProjectPrincipal) {
    this.db.transaction(() => { this.access(projectId, principal, true, true); this.db.prepare('UPDATE shared_projects SET shared=0,updated_at=? WHERE id=?').run(new Date().toISOString(), projectId); this.cancelRevokedJobs(projectId, true); }).immediate();
    return { projectId, shared: false };
  }
  apply(projectId: string, principal: ProjectPrincipal, command: Command): { status: number; body: Record<string, unknown> } {
    for (const operation of command.operations) {
      if ('fields' in operation) assertSafeWire(operation.fields);
      if ('set' in operation) assertSafeWire(operation.set);
      if ('unset' in operation) assertSafeWire(Object.fromEntries((operation.unset ?? []).map(field => [field, null])));
      if ('value' in operation) assertSafeWire(operation.value);
    }
    return this.db.transaction(() => {
      const row = this.access(projectId, principal, true);
      this.generation(row, command.generation);
      const hash = canonicalHash(command);
      const receipt = this.db.prepare('SELECT * FROM shared_project_receipts WHERE project_id=? AND command_id=?').get(projectId, command.commandId) as { actor_id: string; payload_hash: string; status: number; response: string } | undefined;
      if (receipt) {
        if (receipt.actor_id !== principal.id || receipt.payload_hash !== hash) throw new ProjectError(409, 'COMMAND_ID_REUSED', 'Command ID was already used with a different payload');
        return { status: receipt.status, body: JSON.parse(receipt.response) as Record<string, unknown> };
      }
      const snapshot = this.snapshotFromRow(row);
      const baseSnapshot = structuredClone(snapshot);
      const conflicts: Record<string, unknown>[] = [];
      const revision = row.revision + 1;
      const entity = (type: string, id: string): Entity => {
        const found = snapshot.entities.find(item => item.type === type && item.id === id);
        if (!found || found.deleted) throw new ProjectError(409, 'ENTITY_DELETED', 'Entity missing or deleted', { type, id });
        return found;
      };
      const collection = (key: string, expected: number | undefined) => {
        const found = snapshot.collections[key] ?? { ids: [], version: 0 };
        const actual = baseSnapshot.collections[key]?.version ?? 0;
        if (expected === undefined || actual !== expected) conflicts.push({ collection: key, expected, actual });
        snapshot.collections[key] = found;
        return found;
      };
      let operationError: ProjectError | undefined;
      try { for (const op of command.operations) {
        if (op.kind === 'update') {
          const item = entity(op.type, op.id);
          const fields = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
          if (!fields.length || new Set(fields.map(pointer)).size !== fields.length) throw new ProjectError(400, 'INVALID_FIELDS', 'Touched field paths must be unique');
          for (const field of fields) {
            const baseline = baseSnapshot.entities.find(entity => entity.type === op.type && entity.id === op.id);
            const actual = baseline ? fieldVersion(baseline, field) : 0;
            if (op.expected[field] === undefined || op.expected[field] !== actual) conflicts.push({ type: op.type, id: op.id, field, expected: op.expected[field], actual });
          }
          for (const [key, value] of Object.entries(op.set ?? {})) { mutateField(item.fields, key, value); item.versions[pointer(key)] = revision; }
          for (const key of op.unset ?? []) { mutateField(item.fields, key, undefined, true); item.versions[pointer(key)] = revision; }
        } else if (op.kind === 'insert') {
          if (snapshot.entities.some(item => item.type === op.type && item.id === op.id)) throw new ProjectError(409, 'ENTITY_ID_REUSED', 'Entity IDs, including tombstones, cannot be reused');
          snapshot.entities.push({ type: op.type, id: op.id, fields: op.fields, versions: Object.fromEntries(Object.keys(op.fields).map(key => [key, revision])), deleted: false });
          if (op.collection) { const list = collection(op.collection, op.expectedCollectionVersion); if (list.ids.includes(op.id)) throw new ProjectError(400, 'INVALID_COLLECTION', 'Duplicate collection ID'); list.ids.push(op.id); list.version = revision; }
        } else if (op.kind === 'restore') {
          const item = snapshot.entities.find(entity => entity.type === op.type && entity.id === op.id);
          if (!item?.deleted || item.deletedRevision !== op.expectedDeletedRevision) throw new ProjectError(409, 'RESTORE_CONFLICT', 'Explicit restore requires the current tombstone revision');
          item.fields = op.fields; item.versions = Object.fromEntries(Object.keys(op.fields).map(field => [field, revision])); item.deleted = false; delete item.deletedRevision;
          if (op.collection) { const list = collection(op.collection, op.expectedCollectionVersion); if (list.ids.includes(op.id)) throw new ProjectError(400, 'INVALID_COLLECTION', 'Restored ID already in collection'); list.ids.push(op.id); list.version = revision; }
        } else if (op.kind === 'delete') {
          const item = entity(op.type, op.id);
          for (const [field, actual] of Object.entries(baseSnapshot.entities.find(entity => entity.type === op.type && entity.id === op.id)?.versions ?? {})) if ((op.expectedVersions[field] ?? op.expectedVersions[pointer(field)]) !== actual) conflicts.push({ type: op.type, id: op.id, field, expected: op.expectedVersions[field], actual });
          const containing = Object.entries(snapshot.collections).filter(([, list]) => list.ids.includes(op.id));
          if (containing.some(([key]) => key !== op.collection)) throw new ProjectError(400, 'COLLECTION_REQUIRED', 'Delete must include its collection precondition');
          if (op.collection) { const list = collection(op.collection, op.expectedCollectionVersion); list.ids = list.ids.filter(id => id !== op.id); list.version = revision; }
          item.deleted = true; item.deletedRevision = revision;
        } else if (op.kind === 'reorder') {
          const list = collection(op.collection, op.expectedCollectionVersion);
          if (!conflicts.length && (op.ids.length !== list.ids.length || new Set(op.ids).size !== op.ids.length || op.ids.some(id => !list.ids.includes(id)))) throw new ProjectError(400, 'INVALID_REORDER', 'Reorder requires a permutation of current IDs');
          list.ids = op.ids; list.version = revision;
        } else {
          const item = entity(op.type ?? 'asset', op.id ?? op.assetId!);
          const field = op.field ?? 'candidates';
          if (!candidateFieldNames.has(pathParts(field).at(-1)!)) throw new ProjectError(400, 'INVALID_CANDIDATE_FIELD', 'Only media candidate arrays may be appended');
          const existing = readField(item.fields, field);
          if (existing !== undefined && !Array.isArray(existing)) throw new ProjectError(400, 'INVALID_CANDIDATE_FIELD', 'Candidate target must be an array');
          const candidates = (existing ?? []) as Record<string, unknown>[];
          const wrapped = pathParts(field).at(-1) === 'candidates';
          if (!wrapped && op.value.id !== undefined && op.value.id !== op.candidateId) throw new ProjectError(400, 'INVALID_CANDIDATE_ID', 'Candidate value ID does not match candidateId');
          const value = wrapped ? { candidateId: op.candidateId, value: op.value } : { ...op.value, id: op.candidateId };
          const prior = candidates.find(candidate => (candidate.candidateId ?? candidate.id) === op.candidateId);
          if (prior && canonicalHash(prior) !== canonicalHash(value)) throw new ProjectError(409, 'CANDIDATE_ID_REUSED', 'Candidate ID reused');
          if (!prior) { candidates.push(value); mutateField(item.fields, field, candidates); item.versions[pointer(field)] = revision; }

        }
      } } catch (error) { if (error instanceof ProjectError && error.statusCode === 409) operationError = error; else throw error; }
      let result: { status: number; body: Record<string, unknown> };
      if (operationError) result = { status: 409,body:{ error:{code:operationError.code,message:operationError.message},...operationError.details,snapshot:this.snapshotFromRow(row) } };
      else if (conflicts.length) result = { status: 409, body: { error: { code: 'CONFLICT', message: 'Confirmed state changed' }, conflicts, snapshot: this.snapshotFromRow(row) } };
      else {
        snapshot.revision = revision;
        this.db.prepare('UPDATE shared_projects SET revision=?,snapshot=?,updated_at=? WHERE id=?').run(revision, JSON.stringify(snapshot), new Date().toISOString(), projectId);
        this.db.prepare('INSERT INTO shared_project_changes VALUES(?,?,?,?,?)').run(projectId, row.generation, revision, command.commandId, JSON.stringify(command.operations));
        for (const operation of command.operations) if (operation.kind === 'delete' && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_jobs'").get()) this.db.prepare("UPDATE system_jobs SET status='canceled',fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE project_id=? AND target_type=? AND target_id=? AND status IN ('queued','running','uncertain')").run(new Date().toISOString(),projectId,operation.type,operation.id);
        result = { status: 200, body: { commandId: command.commandId, generation: row.generation, revision } };
      }
      this.db.prepare('INSERT INTO shared_project_receipts VALUES(?,?,?,?,?,?)').run(projectId, command.commandId, principal.id, hash, result.status, JSON.stringify(result.body));
      return result;
    }).immediate();
  }
  changes(projectId: string, principal: ProjectPrincipal, generation: number, after: number) {
    const row = this.access(projectId, principal);
    const base = { generation: row.generation, revision: row.revision };
    if (generation !== row.generation || after > row.revision) return { ...base, snapshotRequired: true };
    const changes = this.db.prepare('SELECT revision,command_id AS commandId,operations FROM shared_project_changes WHERE project_id=? AND generation=? AND revision>? ORDER BY revision LIMIT 501').all(projectId, generation, after) as { revision: number; commandId: string; operations: string }[];
    if ((after < row.revision && changes[0]?.revision !== after + 1) || changes.length > 500 || changes.some((change, index) => change.revision !== after + index + 1)) return { ...base, snapshotRequired: true };
    return { ...base, changes: changes.map(change => ({ ...change, operations: JSON.parse(change.operations) as unknown })) };
  }
}
