import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SystemPrincipal } from '../system/types.js';
import { SystemError } from '../system/types.js';
import type { PackageShare, PackageVersion, PackageScope, PackageVersionInput, PackageManifestInput, PackageMediaFact, PackageMediaClaim } from './types.js';

type ShareRow = PackageShare & { requestId: string };
type VersionRow = Omit<PackageVersion, 'sourceDraftId' | 'scope' | 'downloadAvailable' | 'kind'> & { scopeJson: string; url?: string; requestId?: string; snapshotUrl?: string; mediaJson?: string };
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
      CREATE UNIQUE INDEX IF NOT EXISTS package_media_active_claim ON package_share_media_claims(shareId,sha256,size) WHERE status='active';
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
    rows.push(...this.db.prepare('SELECT * FROM package_share_manifest_versions WHERE shareId=?').all(shareId) as VersionRow[]);
    if (this.legacyVersionsExist()) rows.push(...this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=?').all(shareId) as VersionRow[]);
    return rows.sort((a, b) => b.sequence - a.sequence);
  }
  versions(shareId: string) { return this.versionRows(shareId).map(row => this.publicVersion(row)); }
  publicVersion(row: VersionRow): PackageVersion {
    const { versionId, shareId, sequence, draftId, title, size, sha256, publishedBy, createdAt, baseVersionId } = row;
    return { versionId, shareId, sequence, draftId, sourceDraftId: draftId, title, size, sha256, publishedBy, createdAt,
      scope: JSON.parse(row.scopeJson) as PackageScope, baseVersionId: baseVersionId ?? null, downloadAvailable: Boolean(row.url || row.snapshotUrl),
      kind: row.mediaJson !== undefined ? 'manifest' : 'zip',
      ...(row.mediaJson !== undefined ? { snapshot: { sha256, size }, media: JSON.parse(row.mediaJson) as PackageMediaFact[] } : {}) };
  }
  version(shareId: string, versionId: string): VersionRow {
    let row = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) row = this.db.prepare('SELECT * FROM package_share_manifest_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row && this.legacyVersionsExist()) row = this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) throw new SystemError(404, 'PACKAGE_VERSION_UNAVAILABLE', '共享版本不存在');
    return row;
  }
  receipt(shareId: string, principal: SystemPrincipal, requestId: string) {
    this.access(shareId, principal);
    const row = this.db.prepare('SELECT * FROM package_share_manifest_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, requestId)
      ?? this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, requestId);
    return row ? this.publicVersion(row as VersionRow) : null;
  }
  repairSnapshot(shareId: string, versionId: string, principal: SystemPrincipal, input: { url: string; sha256: string; size: number }) {
    return this.db.transaction(() => {
      this.access(shareId, principal);
      const version = this.version(shareId, versionId);
      if (version.mediaJson === undefined || !version.snapshotUrl) throw new SystemError(409, 'PACKAGE_VERSION_NOT_MANIFEST', '该版本不是独立快照格式');
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
      this.db.prepare('SELECT * FROM package_share_manifest_versions WHERE shareId=? ORDER BY sequence DESC LIMIT 1').get(shareId),
      this.legacyVersionsExist() ? this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? ORDER BY sequence DESC LIMIT 1').get(shareId) : undefined
    ].filter(Boolean) as VersionRow[];
    rows.sort((a, b) => b.sequence - a.sequence);
    return rows.length ? this.publicVersion(rows[0]!) : null;
  }
  publishManifest(shareId: string, principal: SystemPrincipal, input: PackageManifestInput) {
    return this.db.transaction(() => {
      const share = this.access(shareId, principal);
      if (input.draftId !== share.draftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '版本来源与共享包绑定的草稿身份不一致');
      if (input.baseVersionId) this.version(shareId, input.baseVersionId);
      const previous = this.db.prepare('SELECT * FROM package_share_manifest_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, input.requestId) as VersionRow | undefined;
      if (previous) {
        if (previous.snapshotUrl !== input.snapshot.url || previous.sha256 !== input.snapshot.sha256 || previous.size !== input.snapshot.size
          || previous.title !== input.title || previous.draftId !== input.draftId || previous.scopeJson !== JSON.stringify(input.scope)
          || previous.mediaJson !== JSON.stringify(input.media) || previous.baseVersionId !== input.baseVersionId) throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于其他内容');
        return this.publicVersion(previous);
      }
      const crossKind = this.db.prepare('SELECT 1 FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, input.requestId);
      if (crossKind) throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于旧ZIP版本');
      const missing = input.media.filter(item => !this.media(shareId, item.sha256, item.size));
      if (missing.length) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '完整版本所需素材尚未全部上传并登记');
      const publicMax = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_public_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const manifestMax = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_manifest_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const legacyMax = this.legacyVersionsExist() ? (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_versions WHERE shareId=?').get(shareId) as { n: number }).n : 0;
      const versionId = `pv_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_manifest_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, shareId, Math.max(publicMax, manifestMax, legacyMax) + 1,
        share.draftId, input.title, input.snapshot.size, input.snapshot.sha256, principal.id, this.now(), input.requestId, input.snapshot.url,
        JSON.stringify(input.scope), input.baseVersionId, JSON.stringify(input.media));
      this.db.prepare('UPDATE package_shares SET updatedAt=? WHERE shareId=?').run(this.now(), shareId);
      return this.publicVersion(this.version(shareId, versionId));
    }).immediate();
  }
  manifestDownload(shareId: string, versionId: string, principal: SystemPrincipal) {
    this.access(shareId, principal);
    const version = this.version(shareId, versionId);
    if (!version.mediaJson || !version.snapshotUrl) throw new SystemError(409, 'PACKAGE_VERSION_NOT_MANIFEST', '该版本使用旧ZIP下载方式');
    const facts = JSON.parse(version.mediaJson) as PackageMediaFact[];
    const media = facts.map(fact => {
      const current = this.media(shareId, fact.sha256, fact.size);
      if (!current) throw new SystemError(409, 'PACKAGE_MEDIA_NOT_READY', '版本素材地址缺失，需要有本地素材的成员修复');
      return { ...fact, url: current.url };
    });
    const repaired = this.db.prepare('SELECT url FROM package_share_snapshot_urls WHERE versionId=?').get(versionId) as { url: string } | undefined;
    return { ...this.publicVersion(version), snapshot: { sha256: version.sha256, size: version.size, url: repaired?.url ?? version.snapshotUrl }, media };
  }

}
