import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SystemPrincipal } from '../system/types.js';
import { SystemError } from '../system/types.js';
import type { PackageShare, PackageVersion, PackageScope, PackageVersionInput, PackageManifestInput, PackageManifestStageInput, PackageMediaFact, PackageMediaClaim } from './types.js';

type ShareRow = PackageShare & { requestId: string };
type VersionRow = Omit<PackageVersion, 'sourceDraftId' | 'scope' | 'downloadAvailable' | 'kind'> & { scopeJson: string | null; url?: string; requestId?: string; snapshotUrl?: string; isManifest?: number };
const manifestColumns = 'versionId,shareId,sequence,draftId,title,size,sha256,publishedBy,createdAt,requestId,snapshotUrl,CASE WHEN EXISTS(SELECT 1 FROM package_share_scope_indexes i WHERE i.versionId=package_share_manifest_versions.versionId) THEN NULL ELSE scopeJson END AS scopeJson,baseVersionId,1 AS isManifest';
type MediaRow = PackageMediaFact & { shareId: string; url: string; uploaderId: string; updatedAt: string };
export class PackageShareStore {
  constructor(private db: Database.Database, private clock: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS package_shares(
      shareId TEXT PRIMARY KEY,draftId TEXT NOT NULL,title TEXT NOT NULL,ownerId TEXT NOT NULL,
      requestId TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,deletedAt TEXT,
      UNIQUE(ownerId,requestId));
      CREATE TABLE IF NOT EXISTS package_share_members(shareId TEXT NOT NULL,userId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','editor')),PRIMARY KEY(shareId,userId));
      CREATE TABLE IF NOT EXISTS package_share_public_versions(versionId TEXT PRIMARY KEY,shareId TEXT NOT NULL,
      sequence INTEGER NOT NULL,draftId TEXT NOT NULL,title TEXT NOT NULL,size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,publishedBy TEXT NOT NULL,createdAt TEXT NOT NULL,requestId TEXT NOT NULL,
      url TEXT NOT NULL,scopeJson TEXT NOT NULL,baseVersionId TEXT,UNIQUE(shareId,sequence),UNIQUE(shareId,publishedBy,requestId));
      CREATE TABLE IF NOT EXISTS package_share_manifest_versions(versionId TEXT PRIMARY KEY,shareId TEXT NOT NULL,
      sequence INTEGER NOT NULL,draftId TEXT NOT NULL,title TEXT NOT NULL,size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,publishedBy TEXT NOT NULL,createdAt TEXT NOT NULL,requestId TEXT NOT NULL,
      snapshotUrl TEXT NOT NULL,scopeJson TEXT NOT NULL,baseVersionId TEXT,mediaJson TEXT NOT NULL,
      UNIQUE(shareId,sequence),UNIQUE(shareId,publishedBy,requestId));
      CREATE TABLE IF NOT EXISTS package_share_snapshot_urls(versionId TEXT PRIMARY KEY,url TEXT NOT NULL,
      updatedBy TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS package_share_media(shareId TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,
      mime TEXT NOT NULL,kind TEXT NOT NULL,url TEXT NOT NULL,uploaderId TEXT NOT NULL,updatedAt TEXT NOT NULL,
      PRIMARY KEY(shareId,sha256,size));
      CREATE TABLE IF NOT EXISTS package_share_media_claims(claimId TEXT PRIMARY KEY,shareId TEXT NOT NULL,sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,actorId TEXT NOT NULL,requestId TEXT NOT NULL,repair INTEGER NOT NULL,status TEXT NOT NULL,
      leaseUntil TEXT NOT NULL,UNIQUE(shareId,actorId,requestId));
      CREATE TABLE IF NOT EXISTS package_share_manifest_stages(stageId TEXT PRIMARY KEY,shareId TEXT NOT NULL,actorId TEXT NOT NULL,
      requestId TEXT NOT NULL,metadataJson TEXT NOT NULL,mediaCount INTEGER NOT NULL,updatedAt TEXT NOT NULL,
      UNIQUE(shareId,actorId,requestId));
      CREATE TABLE IF NOT EXISTS package_share_manifest_stage_media(stageId TEXT NOT NULL,position INTEGER NOT NULL,
      sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(stageId,position));
      CREATE UNIQUE INDEX IF NOT EXISTS package_media_active_claim ON package_share_media_claims(shareId,sha256,size) WHERE status='active';
      CREATE TABLE IF NOT EXISTS package_share_version_media(versionId TEXT NOT NULL,position INTEGER NOT NULL,
      sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL,
      PRIMARY KEY(versionId,position),UNIQUE(versionId,sha256,size));
      CREATE TABLE IF NOT EXISTS package_share_media_indexes(versionId TEXT PRIMARY KEY,mediaCount INTEGER NOT NULL,mediaDigest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS package_share_scope_chunks(ownerId TEXT NOT NULL,position INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(ownerId,position));
      CREATE TABLE IF NOT EXISTS package_share_scope_indexes(versionId TEXT PRIMARY KEY,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,chunks INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS package_share_scope_documents(ownerId TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS package_share_stage_receipts(stageId TEXT PRIMARY KEY,shareId TEXT NOT NULL,actorId TEXT NOT NULL,versionId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS package_share_member_user ON package_share_members(userId,shareId);`);
  }
  private now() { return new Date(this.clock()).toISOString(); }
  assertEligible(principal: SystemPrincipal) {
    if (!principal.emailVerified || principal.disabled || !principal.cloudEligible) throw new SystemError(403, 'PACKAGE_SHARE_ACCOUNT_INELIGIBLE', '有效激活账号可使用整包共享');
  }
  row(shareId: string) { return this.db.prepare('SELECT * FROM package_shares WHERE shareId=?').get(shareId) as ShareRow | undefined; }
  access(shareId: string, principal: SystemPrincipal, owner = false, includeDeleted = false) {
    this.assertEligible(principal);
    const share = this.row(shareId);
    const member = this.db.prepare('SELECT role FROM package_share_members WHERE shareId=? AND userId=?').get(shareId, principal.id) as { role: string } | undefined;
    if (!share || !member) throw new SystemError(404, 'PACKAGE_SHARE_UNAVAILABLE', '共享包不存在或访问权限已撤销');
    if (owner && share.ownerId !== principal.id) throw new SystemError(403, 'PACKAGE_SHARE_OWNER_REQUIRED', '仅共享包所有者可管理成员或删除');
    if (share.deletedAt && !includeDeleted) throw new SystemError(409, 'PACKAGE_SHARE_DELETED', '共享包已删除，可由所有者恢复');
    return share;
  }
  publicShare(row: PackageShare): PackageShare { const { shareId, draftId, title, ownerId, createdAt, updatedAt, deletedAt } = row; return { shareId, draftId, title, ownerId, createdAt, updatedAt, deletedAt }; }
  list(principal: SystemPrincipal) {
    this.assertEligible(principal);
    return (this.db.prepare('SELECT p.* FROM package_shares p JOIN package_share_members m ON m.shareId=p.shareId WHERE m.userId=? ORDER BY p.updatedAt DESC,p.shareId').all(principal.id) as ShareRow[]).map(row => this.publicShare(row));
  }
  create(principal: SystemPrincipal, input: { requestId: string; draftId: string; title: string }) {
    this.assertEligible(principal);
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM package_shares WHERE ownerId=? AND requestId=?').get(principal.id, input.requestId) as ShareRow | undefined;
      if (previous) {
        if (previous.draftId !== input.draftId || previous.title !== input.title) throw new SystemError(409, 'PACKAGE_SHARE_REQUEST_MISMATCH', '请求号已用于另一个共享包');
        return this.publicShare(previous);
      }
      const shareId = `ps_${randomUUID()}`; const now = this.now();
      this.db.prepare('INSERT INTO package_shares VALUES(?,?,?,?,?,?,?,NULL)').run(shareId, input.draftId, input.title, principal.id, input.requestId, now, now);
      this.db.prepare('INSERT INTO package_share_members VALUES(?,?,?)').run(shareId, principal.id, 'owner');
      return this.publicShare(this.row(shareId)!);
    }).immediate();
  }
  members(shareId: string) { return this.db.prepare('SELECT userId,role FROM package_share_members WHERE shareId=? ORDER BY role,userId').all(shareId) as Array<{ userId: string; role: 'owner' | 'editor' }>; }
  addMember(shareId: string, principal: SystemPrincipal, userId: string) {
    this.access(shareId, principal, true);
    if (userId !== principal.id) this.db.prepare("INSERT INTO package_share_members VALUES(?,?,'editor') ON CONFLICT(shareId,userId) DO NOTHING").run(shareId, userId);
    return this.members(shareId);
  }
  removeMember(shareId: string, principal: SystemPrincipal, userId: string) {
    const share = this.access(shareId, principal, true);
    if (share.ownerId === userId) throw new SystemError(400, 'PACKAGE_SHARE_OWNER_IMMUTABLE', '不能移除所有者');
    this.db.prepare('DELETE FROM package_share_members WHERE shareId=? AND userId=?').run(shareId, userId);
    this.db.prepare("UPDATE package_share_media_claims SET status='cancelled' WHERE shareId=? AND actorId=? AND status='active'").run(shareId, userId);
    return this.members(shareId);
  }
  setDeleted(shareId: string, principal: SystemPrincipal, deleted: boolean) {
    this.access(shareId, principal, true, true);
    this.db.prepare('UPDATE package_shares SET deletedAt=?,updatedAt=? WHERE shareId=?').run(deleted ? this.now() : null, this.now(), shareId);
    return this.publicShare(this.row(shareId)!);
  }
  private legacyVersionsExist() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='package_share_versions'").get());
  }
  private versionRows(shareId: string) {
    const rows = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=?').all(shareId) as VersionRow[];
    rows.push(...this.db.prepare(`SELECT ${manifestColumns} FROM package_share_manifest_versions WHERE shareId=?`).all(shareId) as VersionRow[]);
    if (this.legacyVersionsExist()) rows.push(...this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=?').all(shareId) as VersionRow[]);
    return rows.sort((a, b) => b.sequence - a.sequence);
  }
  versions(shareId: string) { return this.versionRows(shareId).map(row => this.publicVersion(row)); }
  publicVersion(row: VersionRow): PackageVersion {
    const { versionId, shareId, sequence, draftId, title, size, sha256, publishedBy, createdAt, baseVersionId } = row;
    return { versionId, shareId, sequence, draftId, sourceDraftId: draftId, title, size, sha256, publishedBy, createdAt,
      scope: row.scopeJson === null ? null : JSON.parse(row.scopeJson) as PackageScope,
      ...(row.scopeJson === null ? this.scopeIndex(row.versionId) : {}), baseVersionId: baseVersionId ?? null, downloadAvailable: Boolean(row.url || row.snapshotUrl),
      kind: row.isManifest === 1 ? 'manifest' : 'zip',
      ...(row.isManifest === 1 ? { snapshot: { sha256, size }, ...this.mediaIndex(row), mediaPageAvailable: true } : {}) };
  }
  version(shareId: string, versionId: string): VersionRow {
    let row = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) row = this.db.prepare(`SELECT ${manifestColumns} FROM package_share_manifest_versions WHERE shareId=? AND versionId=?`).get(shareId, versionId) as VersionRow | undefined;
    if (!row && this.legacyVersionsExist()) row = this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) throw new SystemError(404, 'PACKAGE_VERSION_UNAVAILABLE', '共享版本不存在');
    return row;
  }
  receipt(shareId: string, principal: SystemPrincipal, requestId: string) {
    this.access(shareId, principal);
    const row = this.db.prepare(`SELECT ${manifestColumns} FROM package_share_manifest_versions WHERE shareId=? AND publishedBy=? AND requestId=?`).get(shareId, principal.id, requestId)
      ?? this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, requestId);
    return row ? this.publicVersion(row as VersionRow) : null;
  }
  repairSnapshot(shareId: string, versionId: string, principal: SystemPrincipal, input: { url: string; sha256: string; size: number }) {
    return this.db.transaction(() => {
      this.access(shareId, principal);
      const version = this.version(shareId, versionId);
      if (version.isManifest !== 1 || !version.snapshotUrl) throw new SystemError(409, 'PACKAGE_VERSION_NOT_MANIFEST', '该版本不是独立快照格式');
      if (version.sha256 !== input.sha256 || version.size !== input.size) throw new SystemError(409, 'PACKAGE_SNAPSHOT_IDENTITY_MISMATCH', '修复地址必须对应原快照的相同哈希和大小');
      this.db.prepare(`INSERT INTO package_share_snapshot_urls VALUES(?,?,?,?) ON CONFLICT(versionId)
        DO UPDATE SET url=excluded.url,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`).run(versionId, input.url, principal.id, this.now());
      return this.publicVersion(version);
    }).immediate();
  }
  publish(shareId: string, principal: SystemPrincipal, input: PackageVersionInput) {
    return this.db.transaction(() => {
      const share = this.access(shareId, principal);
      if (input.draftId !== share.draftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '上传来源与共享包绑定的草稿身份不一致');
      if (input.baseVersionId) this.version(shareId, input.baseVersionId);
      if (this.db.prepare('SELECT 1 FROM package_share_manifest_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, input.requestId)) throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于manifest版本');
      const previous = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, input.requestId) as VersionRow | undefined;
      if (previous) {
        if (previous.url !== input.url || previous.scopeJson !== JSON.stringify(input.scope) || previous.baseVersionId !== input.baseVersionId
          || ['draftId','title','size','sha256'].some(key => previous[key as keyof VersionRow] !== input[key as keyof PackageVersionInput])) throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于其他内容');
        return this.publicVersion(previous);
      }
      const newestPublic = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_public_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const newestLegacy = this.legacyVersionsExist() ? (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_versions WHERE shareId=?').get(shareId) as { n: number }).n : 0;
      const newestManifest = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_manifest_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const sequence = Math.max(newestPublic, newestLegacy, newestManifest) + 1;
      const versionId = `pv_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_public_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, shareId, sequence, share.draftId,
        input.title, input.size, input.sha256, principal.id, this.now(), input.requestId, input.url, JSON.stringify(input.scope), input.baseVersionId);
      this.db.prepare('UPDATE package_shares SET updatedAt=? WHERE shareId=?').run(this.now(), shareId);
      return this.publicVersion(this.version(shareId, versionId));
    }).immediate();
  }
  private media(shareId: string, sha256: string, size: number) {
    return this.db.prepare('SELECT * FROM package_share_media WHERE shareId=? AND sha256=? AND size=?').get(shareId, sha256, size) as MediaRow | undefined;
  }
  lookupMedia(shareId: string, principal: SystemPrincipal, items: Array<{ sha256: string; size: number }>) {
    this.access(shareId, principal);
    return items.map(item => {
      const media = this.media(shareId, item.sha256, item.size);
      return { ...item, status: media ? 'ready' : 'missing', ...(media ? { url: media.url } : {}) };
    });
  }
  private claimDto(claim: PackageMediaClaim) { return { status: 'claimed', claimId: claim.claimId, sha256: claim.sha256, size: claim.size, leaseUntil: claim.leaseUntil }; }
  claimMedia(shareId: string, principal: SystemPrincipal, input: { requestId: string; sha256: string; size: number; repair: boolean }) {
    return this.db.transaction(() => {
      this.access(shareId, principal);
      this.db.prepare("UPDATE package_share_media_claims SET status='expired' WHERE shareId=? AND sha256=? AND size=? AND status='active' AND leaseUntil<=?").run(shareId, input.sha256, input.size, this.now());
      const previous = this.db.prepare('SELECT * FROM package_share_media_claims WHERE shareId=? AND actorId=? AND requestId=?').get(shareId, principal.id, input.requestId) as PackageMediaClaim | undefined;
      if (previous && (previous.sha256 !== input.sha256 || previous.size !== input.size || Boolean(previous.repair) !== input.repair)) throw new SystemError(409, 'PACKAGE_MEDIA_REQUEST_MISMATCH', '素材请求号已用于其他内容');
      const ready = this.media(shareId, input.sha256, input.size);
      if (ready && (!input.repair || previous?.status === 'completed')) return { status: 'ready', sha256: input.sha256, size: input.size, url: ready.url };
      const active = this.db.prepare("SELECT * FROM package_share_media_claims WHERE shareId=? AND sha256=? AND size=? AND status='active'").get(shareId, input.sha256, input.size) as PackageMediaClaim | undefined;
      if (active) return previous?.claimId === active.claimId ? this.claimDto(active) : { status: 'busy', sha256: input.sha256, size: input.size, leaseUntil: active.leaseUntil };
      const leaseUntil = new Date(this.clock() + 120000).toISOString();
      const claimId = `pm_${randomUUID()}`;
      if (previous) this.db.prepare("UPDATE package_share_media_claims SET claimId=?,status='active',leaseUntil=? WHERE claimId=?").run(claimId, leaseUntil, previous.claimId);
      else this.db.prepare('INSERT INTO package_share_media_claims VALUES(?,?,?,?,?,?,?,?,?)').run(claimId, shareId, input.sha256, input.size, principal.id, input.requestId, Number(input.repair), 'active', leaseUntil);
      return this.claimDto(this.claim(shareId, claimId, principal));
    }).immediate();
  }
  private claim(shareId: string, claimId: string, principal: SystemPrincipal) {
    this.access(shareId, principal);
    const claim = this.db.prepare('SELECT * FROM package_share_media_claims WHERE shareId=? AND claimId=?').get(shareId, claimId) as PackageMediaClaim | undefined;
    if (!claim) throw new SystemError(404, 'PACKAGE_MEDIA_CLAIM_UNAVAILABLE', '素材上传租约不存在');
    if (claim.actorId !== principal.id) throw new SystemError(403, 'PACKAGE_MEDIA_CLAIM_OWNER_REQUIRED', '素材上传租约属于另一成员');
    return claim;
  }
  renewMediaClaim(shareId: string, claimId: string, principal: SystemPrincipal) {
    return this.db.transaction(() => {
      const claim = this.claim(shareId, claimId, principal);
      if (claim.status !== 'active') throw new SystemError(409, 'PACKAGE_MEDIA_CLAIM_UNAVAILABLE', '素材租约已释放或被其他上传接续，可重新申请');
      // An expired lease may be renewed only until another claimant has fenced it out.
      claim.leaseUntil = new Date(this.clock() + 120000).toISOString();
      this.db.prepare("UPDATE package_share_media_claims SET leaseUntil=? WHERE claimId=? AND status='active'").run(claim.leaseUntil, claimId);
      return this.claimDto(claim);
    }).immediate();
  }
  cancelMediaClaim(shareId: string, claimId: string, principal: SystemPrincipal) {
    const claim = this.claim(shareId, claimId, principal);
    if (claim.status === 'active') this.db.prepare("UPDATE package_share_media_claims SET status='cancelled' WHERE claimId=?").run(claimId);
    return { cancelled: true };
  }
  completeMediaClaim(shareId: string, claimId: string, principal: SystemPrincipal, input: { url: string; mime: string; kind: string }) {
    return this.db.transaction(() => {
      const claim = this.claim(shareId, claimId, principal);
      if (claim.status === 'completed') {
        const ready = this.media(shareId, claim.sha256, claim.size);
        if (!ready) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '素材地址需要修复');
        return { status: 'ready', sha256: claim.sha256, size: claim.size, url: ready.url };
      }
      if (claim.status !== 'active') throw new SystemError(409, 'PACKAGE_MEDIA_CLAIM_UNAVAILABLE', '素材租约已释放或被其他上传接续，可重新申请');
      this.db.prepare(`INSERT INTO package_share_media VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(shareId,sha256,size)
        DO UPDATE SET mime=excluded.mime,kind=excluded.kind,url=excluded.url,uploaderId=excluded.uploaderId,updatedAt=excluded.updatedAt`)
        .run(shareId, claim.sha256, claim.size, input.mime, input.kind, input.url, principal.id, this.now());
      this.db.prepare("UPDATE package_share_media_claims SET status='completed' WHERE claimId=?").run(claimId);
      return { status: 'ready', sha256: claim.sha256, size: claim.size, url: input.url };
    }).immediate();
  }
  latest(shareId: string, principal: SystemPrincipal) {
    this.access(shareId, principal);
    const rows = [
      this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? ORDER BY sequence DESC LIMIT 1').get(shareId),
      this.db.prepare(`SELECT ${manifestColumns} FROM package_share_manifest_versions WHERE shareId=? ORDER BY sequence DESC LIMIT 1`).get(shareId),
      this.legacyVersionsExist() ? this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? ORDER BY sequence DESC LIMIT 1').get(shareId) : undefined
    ].filter(Boolean) as VersionRow[];
    rows.sort((a, b) => b.sequence - a.sequence);
    return rows.length ? this.publicVersion(rows[0]!) : null;
  }
  private mismatch(): never { throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于其他内容'); }
  private metadataMatches(row: VersionRow, input: PackageManifestStageInput) {
    return row.isManifest === 1 && row.snapshotUrl === input.snapshot.url && row.sha256 === input.snapshot.sha256
      && row.size === input.snapshot.size && row.title === input.title && row.draftId === input.draftId
      && (input.scopeTransfer ? this.scopeTransferMatches(row.versionId, input.scopeTransfer) : row.scopeJson === JSON.stringify(input.scope))
      && row.baseVersionId === input.baseVersionId && this.mediaIndex(row).mediaCount === input.mediaCount
      && (!input.mediaDigest || this.mediaIndex(row).mediaDigest === input.mediaDigest);
  }
  private receiptRow(shareId: string, actorId: string, requestId: string): VersionRow | undefined {
    return (this.db.prepare(`SELECT ${manifestColumns} FROM package_share_manifest_versions WHERE shareId=? AND publishedBy=? AND requestId=?`).get(shareId, actorId, requestId)
      ?? this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, actorId, requestId)) as VersionRow | undefined;
  }
  /** Persistent lazy migration: old mediaJson is expanded by SQLite, never parsed into a JS array. */
  private mediaIndex(row: VersionRow): { mediaCount: number; mediaDigest: string } {
    const read = () => this.db.prepare('SELECT mediaCount,mediaDigest FROM package_share_media_indexes WHERE versionId=?').get(row.versionId) as { mediaCount: number; mediaDigest: string } | undefined;
    const existing = read(); if (existing) return existing;
    return this.db.transaction(() => {
      const raced = read(); if (raced) return raced;
      this.db.prepare(`INSERT INTO package_share_version_media(versionId,position,sha256,size,mime,kind)
        SELECT v.versionId,CAST(j.key AS INTEGER),json_extract(j.value,'$.sha256'),json_extract(j.value,'$.size'),json_extract(j.value,'$.mime'),json_extract(j.value,'$.kind')
        FROM package_share_manifest_versions v,json_each(v.mediaJson) j WHERE v.versionId=?`).run(row.versionId);
      const index = this.digestRows('package_share_version_media', 'versionId', row.versionId);
      this.db.prepare('INSERT INTO package_share_media_indexes VALUES(?,?,?)').run(row.versionId, index.mediaCount, index.mediaDigest);
      return index;
    }).immediate();
  }
  private digestRows(table: string, key: string, value: string) {
    const hash = createHash('sha256'); let mediaCount = 0;
    for (const item of this.db.prepare(`SELECT sha256,size,mime,kind FROM ${table} WHERE ${key}=? ORDER BY position`).iterate(value) as Iterable<PackageMediaFact>) {
      hash.update(JSON.stringify(item) + '\n'); mediaCount++;
    }
    return { mediaCount, mediaDigest: hash.digest('hex') };
  }
  publishManifest(shareId: string, principal: SystemPrincipal, input: PackageManifestInput) {
    return this.db.transaction(() => {
      const staged = this.stageManifest(shareId, principal, { ...input, media: undefined, mediaCount: input.media.length } as PackageManifestStageInput);
      if (staged.committed) {
        const row = this.version(shareId, staged.version.versionId), digest = createHash('sha256');
        for (const item of input.media) digest.update(JSON.stringify({ sha256: item.sha256, size: item.size, mime: item.mime, kind: item.kind }) + '\n');
        if (this.mediaIndex(row).mediaDigest !== digest.digest('hex')) this.mismatch();
        return staged.version;
      }
      this.appendManifestMedia(shareId, staged.stageId, principal, 0, input.media);
      return this.commitManifestStage(shareId, staged.stageId, principal);
    }).immediate();
  }
  stageManifest(shareId: string, principal: SystemPrincipal, input: PackageManifestStageInput) {
    return this.db.transaction(() => {
      const share = this.access(shareId, principal);
      if (input.draftId !== share.draftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '版本来源与共享包绑定的草稿身份不一致');
      if (input.baseVersionId) this.version(shareId, input.baseVersionId);
      const existingVersion = this.receiptRow(shareId, principal.id, input.requestId);
      if (existingVersion) {
        if (!this.metadataMatches(existingVersion, input)) this.mismatch();
        return { committed: true as const, version: this.publicVersion(existingVersion), scopeReceived: input.scopeTransfer?.chunks ?? 0 };
      }
      const metadataJson = JSON.stringify({ kind: input.kind, requestId: input.requestId, draftId: input.draftId, title: input.title,
        scope: input.scope, scopeTransfer: input.scopeTransfer, mediaDigest: input.mediaDigest, baseVersionId: input.baseVersionId, snapshot: input.snapshot });
      const previous = this.db.prepare('SELECT * FROM package_share_manifest_stages WHERE shareId=? AND actorId=? AND requestId=?').get(shareId, principal.id, input.requestId) as { stageId: string; metadataJson: string; mediaCount: number } | undefined;
      if (previous) {
        const saved = JSON.parse(previous.metadataJson) as PackageManifestStageInput;
        const comparable = JSON.stringify({ kind: saved.kind, requestId: saved.requestId, draftId: saved.draftId, title: saved.title,
          scope: saved.scope, scopeTransfer: saved.scopeTransfer, mediaDigest: saved.mediaDigest ?? input.mediaDigest, baseVersionId: saved.baseVersionId, snapshot: saved.snapshot });
        // A client upgrade may bind a digest to an existing old stage, but cannot change its frozen metadata.
        if (comparable !== metadataJson || previous.mediaCount !== input.mediaCount) this.mismatch();
        if (saved.mediaDigest === undefined && input.mediaDigest) this.db.prepare('UPDATE package_share_manifest_stages SET metadataJson=? WHERE stageId=?').run(metadataJson, previous.stageId);
        const received = (this.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_stage_media WHERE stageId=?').get(previous.stageId) as { n: number }).n;
        const scopeReceived = (this.db.prepare('SELECT COUNT(*) AS n FROM package_share_scope_chunks WHERE ownerId=?').get(previous.stageId) as { n: number }).n;
        return { committed: false as const, stageId: previous.stageId, received, mediaCount: previous.mediaCount, scopeReceived };
      }
      const stageId = `pms_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_manifest_stages VALUES(?,?,?,?,?,?,?)').run(stageId, shareId, principal.id, input.requestId, metadataJson, input.mediaCount, this.now());
      return { committed: false as const, stageId, received: 0, mediaCount: input.mediaCount, scopeReceived: 0 };
    }).immediate();
  }
  appendManifestMedia(shareId: string, stageId: string, principal: SystemPrincipal, offset: number, items: PackageMediaFact[]) {
    return this.db.transaction(() => {
      this.access(shareId, principal);
      const stage = this.db.prepare('SELECT * FROM package_share_manifest_stages WHERE stageId=? AND shareId=?').get(stageId, shareId) as { actorId: string; mediaCount: number } | undefined;
      if (!stage || stage.actorId !== principal.id) throw new SystemError(404, 'PACKAGE_MANIFEST_STAGE_UNAVAILABLE', '分窗清单不存在或不属于当前成员');
      if (offset + items.length > stage.mediaCount) throw new SystemError(400, 'PACKAGE_MANIFEST_WINDOW_INVALID', '分窗清单超出声明的媒体数量');
      const current = (this.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_stage_media WHERE stageId=?').get(stageId) as { n: number }).n;
      if (offset < current) {
        const saved = this.db.prepare('SELECT sha256,size,mime,kind FROM package_share_manifest_stage_media WHERE stageId=? AND position>=? AND position<? ORDER BY position').all(stageId, offset, offset + items.length);
        if (saved.length !== items.length || JSON.stringify(saved) !== JSON.stringify(items)) throw new SystemError(409, 'PACKAGE_MANIFEST_WINDOW_MISMATCH', '分窗位置已登记为其他媒体');
        return { stageId, received: current, mediaCount: stage.mediaCount };
      }
      if (offset !== current) throw new SystemError(409, 'PACKAGE_MANIFEST_WINDOW_GAP', '分窗清单必须从服务器已确认位置继续');
      const insert = this.db.prepare('INSERT INTO package_share_manifest_stage_media VALUES(?,?,?,?,?,?)');
      items.forEach((item, index) => insert.run(stageId, offset + index, item.sha256, item.size, item.mime, item.kind));
      this.db.prepare('UPDATE package_share_manifest_stages SET updatedAt=? WHERE stageId=?').run(this.now(), stageId);
      return { stageId, received: offset + items.length, mediaCount: stage.mediaCount };
    }).immediate();
  }
  commitManifestStage(shareId: string, stageId: string, principal: SystemPrincipal) {
    return this.db.transaction(() => {
      const share = this.access(shareId, principal);
      const stage = this.db.prepare('SELECT * FROM package_share_manifest_stages WHERE stageId=? AND shareId=?').get(stageId, shareId) as { actorId: string; requestId: string; metadataJson: string; mediaCount: number } | undefined;
      if (!stage || stage.actorId !== principal.id) {
        const receipt = this.db.prepare('SELECT versionId FROM package_share_stage_receipts WHERE stageId=? AND shareId=? AND actorId=?').get(stageId, shareId, principal.id) as { versionId: string } | undefined;
        if (receipt) return this.publicVersion(this.version(shareId, receipt.versionId));
        throw new SystemError(404, 'PACKAGE_MANIFEST_STAGE_UNAVAILABLE', '分窗清单不存在或不属于当前成员');
      }
      const count = this.db.prepare('SELECT COUNT(*) AS n,MIN(position) AS first,MAX(position) AS last FROM package_share_manifest_stage_media WHERE stageId=?').get(stageId) as { n: number; first: number | null; last: number | null };
      if (count.n !== stage.mediaCount || count.n && (count.first !== 0 || count.last !== count.n - 1)) throw new SystemError(409, 'PACKAGE_MANIFEST_INCOMPLETE', '分窗清单尚未登记完整，未提交版本');
      if (this.db.prepare('SELECT 1 FROM package_share_manifest_stage_media WHERE stageId=? GROUP BY sha256,size HAVING COUNT(*)>1 LIMIT 1').get(stageId)) throw new SystemError(409, 'PACKAGE_MANIFEST_DUPLICATE_MEDIA', '完整版本含重复媒体身份');
      if (this.db.prepare(`SELECT 1 FROM package_share_manifest_stage_media s LEFT JOIN package_share_media m ON m.shareId=? AND m.sha256=s.sha256 AND m.size=s.size WHERE s.stageId=? AND m.sha256 IS NULL LIMIT 1`).get(shareId, stageId)) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '完整版本所需素材尚未全部上传并登记');
      const input = JSON.parse(stage.metadataJson) as PackageManifestStageInput;
      const previous = this.receiptRow(shareId, principal.id, stage.requestId);
      const index = this.digestRows('package_share_manifest_stage_media', 'stageId', stageId);
      if (input.mediaDigest && index.mediaDigest !== input.mediaDigest) this.mismatch();
      if (input.scopeTransfer) this.validateScopeTransfer(stageId, input.scopeTransfer);
      if (previous) {
        if (!this.metadataMatches(previous, { ...input, mediaCount: stage.mediaCount }) || this.mediaIndex(previous).mediaDigest !== index.mediaDigest) this.mismatch();
        return this.publicVersion(previous);
      }
      const max = (table: string) => (this.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS n FROM ${table} WHERE shareId=?`).get(shareId) as { n: number }).n;
      const sequence = Math.max(max('package_share_public_versions'), max('package_share_manifest_versions'), this.legacyVersionsExist() ? max('package_share_versions') : 0) + 1;
      const versionId = `pv_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_manifest_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,(SELECT json FROM package_share_scope_documents WHERE ownerId=?)),?,?)').run(versionId, shareId, sequence,
        share.draftId, input.title, input.snapshot.size, input.snapshot.sha256, principal.id, this.now(), stage.requestId, input.snapshot.url,
        input.scope ? JSON.stringify(input.scope) : null, stageId, input.baseVersionId, '[]');
      if (input.scopeTransfer) {
        this.db.prepare('INSERT INTO package_share_scope_chunks SELECT ?,position,text FROM package_share_scope_chunks WHERE ownerId=?').run(versionId, stageId);
        this.db.prepare('INSERT INTO package_share_scope_indexes VALUES(?,?,?,?)').run(versionId, input.scopeTransfer.bytes, input.scopeTransfer.sha256, input.scopeTransfer.chunks);
      }
      this.db.prepare('INSERT INTO package_share_version_media SELECT ?,position,sha256,size,mime,kind FROM package_share_manifest_stage_media WHERE stageId=?').run(versionId, stageId);
      this.db.prepare('INSERT INTO package_share_media_indexes VALUES(?,?,?)').run(versionId, index.mediaCount, index.mediaDigest);
      this.db.prepare('INSERT INTO package_share_stage_receipts VALUES(?,?,?,?)').run(stageId, shareId, principal.id, versionId);
      this.db.prepare('UPDATE package_shares SET updatedAt=? WHERE shareId=?').run(this.now(), shareId);
      this.db.prepare('DELETE FROM package_share_manifest_stage_media WHERE stageId=?').run(stageId);
      this.db.prepare('DELETE FROM package_share_manifest_stages WHERE stageId=?').run(stageId);
      this.db.prepare('DELETE FROM package_share_scope_chunks WHERE ownerId=?').run(stageId);
      this.db.prepare('DELETE FROM package_share_scope_documents WHERE ownerId=?').run(stageId);
      return this.publicVersion(this.version(shareId, versionId));
    }).immediate();
  }
  manifestDownload(shareId: string, versionId: string, principal: SystemPrincipal) {
    this.access(shareId, principal);
    const version = this.version(shareId, versionId);
    if (version.isManifest !== 1 || !version.snapshotUrl) throw new SystemError(409, 'PACKAGE_VERSION_NOT_MANIFEST', '该版本使用旧ZIP下载方式');
    this.mediaIndex(version);
    if (this.db.prepare('SELECT 1 FROM package_share_version_media f LEFT JOIN package_share_media m ON m.shareId=? AND m.sha256=f.sha256 AND m.size=f.size WHERE f.versionId=? AND m.sha256 IS NULL LIMIT 1').get(shareId, versionId)) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '版本素材地址缺失，需要有本地素材的成员修复');
    const repaired = this.db.prepare('SELECT url FROM package_share_snapshot_urls WHERE versionId=?').get(versionId) as { url: string } | undefined;
    return { ...this.publicVersion(version), snapshot: { sha256: version.sha256, size: version.size, url: repaired?.url ?? version.snapshotUrl } };
  }
  private scopeIndex(versionId: string) {
    const index = this.db.prepare('SELECT bytes,sha256,chunks FROM package_share_scope_indexes WHERE versionId=?').get(versionId) as { bytes: number; sha256: string; chunks: number } | undefined;
    if (!index) throw new SystemError(409, 'PACKAGE_SCOPE_INCOMPLETE', '版本范围索引不存在');
    const summary = this.db.prepare(`SELECT json_extract(scopeJson,'$.kind') AS kind,json_array_length(scopeJson,'$.episodeIds') AS episodeCount,
      json_extract(scopeJson,'$.sourceEpisodeCount') AS sourceEpisodeCount FROM package_share_manifest_versions WHERE versionId=?`).get(versionId) as { kind: 'all' | 'selected-episodes'; episodeCount: number; sourceEpisodeCount: number };
    return { scopePageAvailable: true, scopeBytes: index.bytes, scopeDigest: index.sha256, scopeChunks: index.chunks, scopeSummary: summary };
  }
  private scopeTransferMatches(versionId: string, transfer: { bytes: number; sha256: string; chunks: number }) {
    const saved = this.db.prepare('SELECT bytes,sha256,chunks FROM package_share_scope_indexes WHERE versionId=?').get(versionId) as { bytes: number; sha256: string; chunks: number } | undefined;
    return saved?.bytes === transfer.bytes && saved.sha256 === transfer.sha256 && saved.chunks === transfer.chunks;
  }
  appendScope(shareId: string, stageId: string, principal: SystemPrincipal, offset: number, items: string[]) {
    return this.db.transaction(() => {
      this.access(shareId, principal);
      const stage = this.db.prepare('SELECT actorId,metadataJson FROM package_share_manifest_stages WHERE stageId=? AND shareId=?').get(stageId, shareId) as { actorId: string; metadataJson: string } | undefined;
      if (!stage || stage.actorId !== principal.id) throw new SystemError(404, 'PACKAGE_MANIFEST_STAGE_UNAVAILABLE', '分窗清单不存在或不属于当前成员');
      const transfer = (JSON.parse(stage.metadataJson) as PackageManifestStageInput).scopeTransfer;
      if (!transfer || offset + items.length > transfer.chunks) throw new SystemError(409, 'PACKAGE_SCOPE_WINDOW_INVALID', '范围分窗超出声明数量');
      const current = (this.db.prepare('SELECT COUNT(*) AS n FROM package_share_scope_chunks WHERE ownerId=?').get(stageId) as { n: number }).n;
      if (offset < current) {
        const previous = this.db.prepare('SELECT text FROM package_share_scope_chunks WHERE ownerId=? AND position>=? AND position<? ORDER BY position').all(stageId, offset, offset + items.length) as Array<{ text: string }>;
        if (previous.length !== items.length || previous.some((row, i) => row.text !== items[i])) this.mismatch();
        return { stageId, scopeReceived: current };
      }
      if (offset !== current) throw new SystemError(409, 'PACKAGE_SCOPE_WINDOW_GAP', '范围分窗必须从已确认位置继续');
      const insert = this.db.prepare('INSERT INTO package_share_scope_chunks VALUES(?,?,?)');
      items.forEach((item, i) => insert.run(stageId, offset + i, item));
      return { stageId, scopeReceived: current + items.length };
    }).immediate();
  }
  private validateScopeTransfer(stageId: string, transfer: { bytes: number; sha256: string; chunks: number }) {
    const hash = createHash('sha256'); let bytes = 0, chunks = 0;
    for (const item of this.db.prepare('SELECT position,text FROM package_share_scope_chunks WHERE ownerId=? ORDER BY position').iterate(stageId) as Iterable<{ position: number; text: string }>) {
      if (item.position !== chunks) throw new SystemError(409, 'PACKAGE_SCOPE_INCOMPLETE', '范围分窗位置不完整');
      bytes += Buffer.byteLength(item.text); hash.update(item.text); chunks++;
    }
    if (chunks !== transfer.chunks || bytes !== transfer.bytes || hash.digest('hex') !== transfer.sha256) throw new SystemError(409, 'PACKAGE_SCOPE_INCOMPLETE', '范围分窗数量、字节或摘要不一致');
    this.db.prepare("INSERT INTO package_share_scope_documents SELECT ?,group_concat(text,'') FROM (SELECT text FROM package_share_scope_chunks WHERE ownerId=? ORDER BY position)").run(stageId, stageId);
    const reject = () => { throw new SystemError(400, 'PACKAGE_SCOPE_INVALID', '完整范围JSON结构无效'); };
    const valid = this.db.prepare('SELECT json_valid(json) AS ok FROM package_share_scope_documents WHERE ownerId=?').get(stageId) as { ok: number };
    if (!valid.ok) reject();
    const header = this.db.prepare(`SELECT json_type(json) AS type,json_extract(json,'$.kind') AS kind,json_type(json,'$.sourceEpisodeCount') AS countType,
      json_extract(json,'$.sourceEpisodeCount') AS sourceCount,json_type(json,'$.episodeIds') AS episodeType,json_array_length(json,'$.episodeIds') AS episodes,
      json_type(json,'$.assetOrigins') AS originsType FROM package_share_scope_documents WHERE ownerId=?`).get(stageId) as { type: string; kind: string; countType: string; sourceCount: number; episodeType: string; episodes: number; originsType: string | null };
    if (header.type !== 'object' || !['all','selected-episodes'].includes(header.kind) || header.countType !== 'integer' || !Number.isSafeInteger(header.sourceCount) || header.sourceCount < 0 || header.episodeType !== 'array'
      || (header.kind === 'all' ? header.sourceCount !== header.episodes : !header.episodes || header.sourceCount <= header.episodes) || header.originsType !== null && header.originsType !== 'array') reject();
    const checks = [
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json) j WHERE d.ownerId=? AND j.key NOT IN ('kind','sourceEpisodeCount','episodeIds','assetOrigins') LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.episodeIds') j WHERE d.ownerId=? AND (j.type<>'text' OR length(j.value)<1 OR length(j.value)>200) LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.episodeIds') j WHERE d.ownerId=? GROUP BY j.value HAVING COUNT(*)>1 LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.assetOrigins') j WHERE d.ownerId=? AND j.type<>'object' LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.assetOrigins') j WHERE d.ownerId=? AND ( json_type(j.value,'$.assetId') IS NOT 'text' OR length(json_extract(j.value,'$.assetId')) NOT BETWEEN 1 AND 200) LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.assetOrigins') j WHERE d.ownerId=? GROUP BY json_extract(j.value,'$.assetId') HAVING COUNT(*)>1 LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.assetOrigins') j,json_each(j.value) f WHERE d.ownerId=? AND (f.key NOT IN ('assetId','episodeId','sourceEpisodeIds','validFrom','validUntil') OR f.key IN ('episodeId','validFrom','validUntil') AND f.type<>'text' OR f.key='episodeId' AND length(f.value) NOT BETWEEN 1 AND 200 OR f.key='sourceEpisodeIds' AND f.type<>'array') LIMIT 1`,
      `SELECT 1 FROM package_share_scope_documents d,json_each(d.json,'$.assetOrigins') j,json_each(j.value,'$.sourceEpisodeIds') f WHERE d.ownerId=? AND (f.type<>'text' OR length(f.value) NOT BETWEEN 1 AND 200) LIMIT 1`
    ];
    for (const sql of checks) if (this.db.prepare(sql).get(stageId)) reject();
  }
  scopePage(shareId: string, versionId: string, principal: SystemPrincipal, after: number, limit: number) {
    this.access(shareId, principal); this.version(shareId, versionId);
    const index = this.scopeIndex(versionId);
    if (after > index.scopeChunks) throw new SystemError(409, 'PACKAGE_SCOPE_CURSOR_INVALID', '范围游标超出完整清单');
    const items = this.db.prepare('SELECT position,text FROM package_share_scope_chunks WHERE ownerId=? AND position>=? ORDER BY position LIMIT ?').all(versionId, after, limit) as Array<{ position: number; text: string }>;
    const nextAfter = after + items.length;
    if (items.some((item, i) => item.position !== after + i) || nextAfter < index.scopeChunks && !items.length) throw new SystemError(409, 'PACKAGE_SCOPE_INCOMPLETE', '范围索引不完整');
    return { versionId, bytes: index.scopeBytes, sha256: index.scopeDigest, chunks: index.scopeChunks, items, nextAfter, complete: nextAfter === index.scopeChunks };
  }
  mediaPage(shareId: string, versionId: string, principal: SystemPrincipal, after: number, limit: number) {
    this.access(shareId, principal); const row = this.version(shareId, versionId);
    if (row.isManifest !== 1) throw new SystemError(409, 'PACKAGE_VERSION_NOT_MANIFEST', '该版本使用旧ZIP下载方式');
    const index = this.mediaIndex(row);
    if (after > index.mediaCount) throw new SystemError(409, 'PACKAGE_MEDIA_CURSOR_INVALID', '媒体游标超出完整清单');
    const items = this.db.prepare(`SELECT f.position,f.sha256,f.size,f.mime,f.kind,m.url FROM package_share_version_media f
      LEFT JOIN package_share_media m ON m.shareId=? AND m.sha256=f.sha256 AND m.size=f.size WHERE f.versionId=? AND f.position>=? ORDER BY f.position LIMIT ?`).all(shareId, versionId, after, limit) as Array<PackageMediaFact & { position: number; url: string | null }>;
    if (items.some(item => !item.url)) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '版本素材地址缺失，需要有本地素材的成员修复');
    const nextAfter = after + items.length;
    if (items.some((item, i) => item.position !== after + i) || nextAfter < index.mediaCount && !items.length) throw new SystemError(409, 'PACKAGE_MANIFEST_INCOMPLETE', '版本媒体索引不完整');
    return { versionId, ...index, items, nextAfter, complete: nextAfter === index.mediaCount };
  }
  /** Old clients receive their original arrays via streamed JSON, without a full manifest array/Buffer. */
  *legacyResponse(value: unknown, urls = false): Generator<string> {
    if (Array.isArray(value)) {
      yield '['; for (let i = 0; i < value.length; i++) { if (i) yield ','; yield* this.legacyResponse(value[i], urls); } yield ']'; return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>; yield '{'; let first = true;
      for (const [key, item] of Object.entries(obj)) { if (item === undefined) continue; if (!first) yield ','; first = false; yield JSON.stringify(key) + ':'; if (key === 'scope' && obj.scopePageAvailable === true) { for (const part of this.db.prepare('SELECT text FROM package_share_scope_chunks WHERE ownerId=? ORDER BY position').iterate(obj.versionId) as Iterable<{ text: string }>) yield part.text; } else yield* this.legacyResponse(item, urls); }
      if (obj.kind === 'manifest' && typeof obj.versionId === 'string') {
        if (!first) yield ','; yield '\"media\":['; let count = 0;
        const sql = urls ? `SELECT f.sha256,f.size,f.mime,f.kind,m.url FROM package_share_version_media f LEFT JOIN package_share_media m ON m.shareId=? AND m.sha256=f.sha256 AND m.size=f.size WHERE f.versionId=? ORDER BY f.position`
          : 'SELECT sha256,size,mime,kind FROM package_share_version_media WHERE versionId=? ORDER BY position';
        const rows = this.db.prepare(sql).iterate(...(urls ? [obj.shareId, obj.versionId] : [obj.versionId]));
        for (const row of rows) { if (count++) yield ','; yield JSON.stringify(row); } yield ']';
      }
      yield '}'; return;
    }
    yield JSON.stringify(value) ?? 'null';
  }
  listPage(principal: SystemPrincipal, afterShareId: string, limit: number) {
    this.assertEligible(principal);
    const rows = this.db.prepare('SELECT p.* FROM package_shares p JOIN package_share_members m ON m.shareId=p.shareId WHERE m.userId=? AND p.shareId>? ORDER BY p.shareId LIMIT ?').all(principal.id, afterShareId, limit + 1) as ShareRow[];
    const complete = rows.length <= limit, data = rows.slice(0, limit).map(row => this.publicShare(row));
    return { data, complete, nextAfterShareId: data.at(-1)?.shareId ?? afterShareId };
  }
  versionsPage(shareId: string, beforeSequence: number, limit: number) {
    const tables = ['package_share_public_versions', 'package_share_manifest_versions', ...(this.legacyVersionsExist() ? ['package_share_versions'] : [])];
    const sql = tables.map(table => `SELECT versionId,sequence FROM ${table} WHERE shareId=@shareId AND sequence<@beforeSequence`).join(' UNION ALL ');
    const keys = this.db.prepare(`${sql} ORDER BY sequence DESC LIMIT @limit`).all({ shareId, beforeSequence, limit: limit + 1 }) as Array<{ versionId: string; sequence: number }>;
    const complete = keys.length <= limit, rows = keys.slice(0, limit);
    return { versions: rows.map(key => this.publicVersion(this.version(shareId, key.versionId))), versionsComplete: complete, nextBeforeSequence: rows.at(-1)?.sequence ?? beforeSequence };
  }
}
