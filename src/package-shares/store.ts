import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SystemPrincipal } from '../system/types.js';
import { SystemError } from '../system/types.js';
import type { PackageShare, PackageVersion, PackageScope, PackageVersionInput } from './types.js';

type ShareRow = PackageShare & { requestId: string };
type VersionRow = Omit<PackageVersion, 'sourceDraftId' | 'scope' | 'downloadAvailable'> & { scopeJson: string; url?: string; requestId?: string };
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
  private legacyVersionsExist() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='package_share_versions'").get());
  }
  private versionRows(shareId: string) {
    const rows = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=?').all(shareId) as VersionRow[];
    if (this.legacyVersionsExist()) rows.push(...this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=?').all(shareId) as VersionRow[]);
    return rows.sort((a, b) => b.sequence - a.sequence);
  }
  versions(shareId: string) { return this.versionRows(shareId).map(row => this.publicVersion(row)); }
  publicVersion(row: VersionRow): PackageVersion {
    const { versionId, shareId, sequence, draftId, title, size, sha256, publishedBy, createdAt, baseVersionId } = row;
    return { versionId, shareId, sequence, draftId, sourceDraftId: draftId, title, size, sha256, publishedBy, createdAt,
      scope: JSON.parse(row.scopeJson) as PackageScope, baseVersionId: baseVersionId ?? null, downloadAvailable: typeof row.url === 'string' && Boolean(row.url) };
  }
  version(shareId: string, versionId: string): VersionRow {
    let row = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row && this.legacyVersionsExist()) row = this.db.prepare('SELECT * FROM package_share_versions WHERE shareId=? AND versionId=?').get(shareId, versionId) as VersionRow | undefined;
    if (!row) throw new SystemError(404, 'PACKAGE_VERSION_UNAVAILABLE', '共享版本不存在');
    return row;
  }
  publish(shareId: string, principal: SystemPrincipal, input: PackageVersionInput) {
    return this.db.transaction(() => {
      const share = this.access(shareId, principal);
      if (input.draftId !== share.draftId) throw new SystemError(409, 'PACKAGE_SHARE_SOURCE_MISMATCH', '上传来源与共享包绑定的草稿身份不一致');
      if (input.baseVersionId) this.version(shareId, input.baseVersionId);
      const previous = this.db.prepare('SELECT * FROM package_share_public_versions WHERE shareId=? AND publishedBy=? AND requestId=?').get(shareId, principal.id, input.requestId) as VersionRow | undefined;
      if (previous) {
        if (previous.url !== input.url || previous.scopeJson !== JSON.stringify(input.scope) || previous.baseVersionId !== input.baseVersionId
          || ['draftId','title','size','sha256'].some(key => previous[key as keyof VersionRow] !== input[key as keyof PackageVersionInput])) throw new SystemError(409, 'PACKAGE_VERSION_REQUEST_MISMATCH', '发布请求号已用于其他内容');
        return this.publicVersion(previous);
      }
      const newestPublic = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_public_versions WHERE shareId=?').get(shareId) as { n: number }).n;
      const newestLegacy = this.legacyVersionsExist() ? (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM package_share_versions WHERE shareId=?').get(shareId) as { n: number }).n : 0;
      const sequence = Math.max(newestPublic, newestLegacy) + 1;
      const versionId = `pv_${randomUUID()}`;
      this.db.prepare('INSERT INTO package_share_public_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, shareId, sequence, share.draftId,
        input.title, input.size, input.sha256, principal.id, this.now(), input.requestId, input.url, JSON.stringify(input.scope), input.baseVersionId);
      this.db.prepare('UPDATE package_shares SET updatedAt=? WHERE shareId=?').run(this.now(), shareId);
      return this.publicVersion(this.version(shareId, versionId));
    }).immediate();
  }
}
