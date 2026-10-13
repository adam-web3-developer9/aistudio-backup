import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SystemPrincipal } from '../system/types.js';
import { SystemError } from '../system/types.js';
import type { PackageShare, PackageUpload, PackageVersion, PackageScope } from './types.js';

type ShareRow = PackageShare & { requestId: string };
type VersionRow = PackageVersion & { uploadId: string; objectKey: string };
export class PackageShareStore {
  constructor(private db: Database.Database, private clock: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS package_shares(
      shareId TEXT PRIMARY KEY,draftId TEXT NOT NULL,title TEXT NOT NULL,ownerId TEXT NOT NULL,
      requestId TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,deletedAt TEXT,
      UNIQUE(ownerId,requestId));
      CREATE TABLE IF NOT EXISTS package_share_members(shareId TEXT NOT NULL,userId TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','editor')),PRIMARY KEY(shareId,userId));
      CREATE TABLE IF NOT EXISTS package_share_uploads(uploadId TEXT PRIMARY KEY,shareId TEXT NOT NULL,
      actorId TEXT NOT NULL,requestId TEXT NOT NULL,objectKey TEXT NOT NULL UNIQUE,storageUploadId TEXT,
      draftId TEXT NOT NULL,title TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
      partSize INTEGER NOT NULL,partCount INTEGER NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,versionId TEXT,scopeJson TEXT NOT NULL,baseVersionId TEXT,initializationToken TEXT,initializationUntil INTEGER,UNIQUE(shareId,actorId,requestId));
      CREATE TABLE IF NOT EXISTS package_share_versions(versionId TEXT PRIMARY KEY,shareId TEXT NOT NULL,
      sequence INTEGER NOT NULL,draftId TEXT NOT NULL,title TEXT NOT NULL,size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,publishedBy TEXT NOT NULL,createdAt TEXT NOT NULL,uploadId TEXT NOT NULL UNIQUE,
      objectKey TEXT NOT NULL UNIQUE,scopeJson TEXT NOT NULL,baseVersionId TEXT,UNIQUE(shareId,sequence));
      CREATE TABLE IF NOT EXISTS package_share_download_leases(leaseId TEXT PRIMARY KEY,versionId TEXT NOT NULL,
      userId TEXT NOT NULL,expiresAt TEXT NOT NULL,createdAt TEXT NOT NULL);
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
    return this.members(shareId);
  }
  setDeleted(shareId: string, principal: SystemPrincipal, deleted: boolean) {
    this.access(shareId, principal, true, true);
    this.db.prepare('UPDATE package_shares SET deletedAt=?,updatedAt=? WHERE shareId=?').run(deleted ? this.now() : null, this.now(), shareId);
    return this.publicShare(this.row(shareId)!);
  }
  versions(shareId: string) {
    return (this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? ORDER BY sequence DESC').all(shareId) as VersionRow[]).map(row => this.publicVersion({ ...row, scope: JSON.parse((row as unknown as { scopeJson: string }).scopeJson) as PackageScope }));
  }
  publicVersion(row: VersionRow): PackageVersion { const { versionId, shareId, sequence, draftId, title, size, sha256, publishedBy, createdAt, scope, baseVersionId } = row; return { versionId, shareId, sequence, draftId, sourceDraftId: draftId, title, size, sha256, publishedBy, createdAt, scope, baseVersionId }; }
  version(shareId: string, versionId: string) {
    const row = this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) throw new SystemError(404, 'PACKAGE_VERSION_UNAVAILABLE', '共享版本不存在');
    return { ...row, sourceDraftId: row.draftId, scope: JSON.parse((row as unknown as { scopeJson: string }).scopeJson) as PackageScope };
  }
  upload(shareId: string, uploadId: string) {
    const row = this.db.prepare('SELECT * FROM package_share_uploads WHERE shareId=? AND uploadId=?').get(shareId, uploadId) as PackageUpload | undefined;
    if (!row) throw new SystemError(404, 'PACKAGE_UPLOAD_UNAVAILABLE', '上传任务不存在');
    return { ...row, scope: JSON.parse((row as unknown as { scopeJson: string }).scopeJson) as PackageScope };
  }
  uploadAccess(shareId: string, uploadId: string, principal: SystemPrincipal, active = false, includeDeleted = false) {
    const share = this.access(shareId, principal, false, includeDeleted);
    const upload = this.upload(shareId, uploadId);
    if (upload.actorId !== principal.id && share.ownerId !== principal.id) throw new SystemError(403, 'PACKAGE_UPLOAD_OWNER_REQUIRED', '该上传属于另一成员');
    if (active && upload.status === 'cancelled') throw new SystemError(410, 'PACKAGE_UPLOAD_CANCELLED', '上传已取消');
    // This is a renewable retention lease, never a total elapsed-time limit on a local package.
    if (active && upload.status !== 'completed' && Date.parse(upload.expiresAt) <= this.clock()) {
      upload.expiresAt = new Date(this.clock() + 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare('UPDATE package_share_uploads SET expiresAt=? WHERE uploadId=?').run(upload.expiresAt, uploadId);
    }
    return upload;
  }
  reserveUpload(shareId: string, principal: SystemPrincipal, input: { requestId: string; draftId: string; title: string; size: number; sha256: string; partSize: number; partCount: number; scope: PackageScope; baseVersionId: string | null }) {
    const share = this.access(shareId, principal);
    if (input.draftId !== share.draftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '上传来源与共享包绑定的草稿身份不一致');
    if (input.baseVersionId) this.version(shareId, input.baseVersionId);
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM package_share_uploads WHERE shareId=? AND actorId=? AND requestId=?').get(shareId, principal.id, input.requestId) as PackageUpload | undefined;
      if (previous) {
        if (JSON.stringify(input.scope) !== (previous as unknown as { scopeJson: string }).scopeJson || previous.baseVersionId !== input.baseVersionId || ['draftId', 'title', 'size', 'sha256'].some(key => previous[key as keyof PackageUpload] !== input[key as keyof typeof input])) throw new SystemError(409, 'PACKAGE_UPLOAD_REQUEST_MISMATCH', '上传请求号已用于其他内容');
        return this.upload(shareId, previous.uploadId);
      }
      const uploadId = `pu_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_uploads VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?, ?,?,NULL,?,?,NULL,NULL)').run(uploadId, shareId, principal.id, input.requestId, `package-shares/${shareId}/${uploadId}.zip`, input.draftId, input.title, input.size, input.sha256, input.partSize, input.partCount, 'initializing', this.now(), new Date(this.clock() + 24 * 60 * 60 * 1000).toISOString(), JSON.stringify(input.scope), input.baseVersionId);
      return this.upload(shareId, uploadId);
    }).immediate();
  }
  claimInitialization(uploadId: string): string | null {
    const token = randomUUID();
    // Durable fencing covers two SDK attempts of 30s each, across process restart.
    const changed = this.db.prepare("UPDATE package_share_uploads SET initializationToken=?,initializationUntil=? WHERE uploadId=? AND status='initializing' AND (initializationUntil IS NULL OR initializationUntil<=?)").run(token, this.clock() + 120000, uploadId, this.clock()).changes;
    return changed ? token : null;
  }
  initialized(uploadId: string, storageUploadId: string, token: string) {
    return this.db.prepare("UPDATE package_share_uploads SET storageUploadId=?,status='uploading',initializationToken=NULL,initializationUntil=NULL WHERE uploadId=? AND status='initializing' AND initializationToken=?").run(storageUploadId, uploadId, token).changes === 1;
  }
  releaseInitialization(uploadId: string, token: string) { this.db.prepare("UPDATE package_share_uploads SET initializationToken=NULL,initializationUntil=NULL WHERE uploadId=? AND status='initializing' AND initializationToken=?").run(uploadId, token); }
  cancelled(uploadId: string) { this.db.prepare("UPDATE package_share_uploads SET status='cancelled' WHERE uploadId=? AND status!='completed'").run(uploadId); }
  publish(shareId: string, uploadId: string, principal: SystemPrincipal) {
    return this.db.transaction(() => {
      const upload = this.uploadAccess(shareId, uploadId, principal, true);
      if (upload.versionId) return this.publicVersion(this.version(shareId, upload.versionId));
      const sourceDraftId = this.row(shareId)!.draftId;
      if (upload.draftId !== sourceDraftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '上传来源与共享包绑定的草稿身份不一致');
      const sequence = (this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM package_share_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const versionId = `pv_${randomUUID()}`; const now = this.now();
      this.db.prepare('INSERT INTO package_share_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, shareId, sequence, sourceDraftId, upload.title, upload.size, upload.sha256, upload.actorId, now, uploadId, upload.objectKey, JSON.stringify(upload.scope), upload.baseVersionId);
      this.db.prepare("UPDATE package_share_uploads SET status='completed',versionId=? WHERE uploadId=?").run(versionId, uploadId);
      this.db.prepare('UPDATE package_shares SET updatedAt=? WHERE shareId=?').run(now, shareId);
      return this.publicVersion(this.version(shareId, versionId));
    }).immediate();
  }
  downloadLease(versionId: string, userId: string, expiresAt: string) {
    this.db.prepare('INSERT INTO package_share_download_leases VALUES(?,?,?,?,?)').run(`pd_${randomUUID()}`, versionId, userId, expiresAt, this.now());
  }
}
