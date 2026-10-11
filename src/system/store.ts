import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SystemError, type ActivationCode, type AdminRole, type AuditInput, type ListQuery, type ListResult, type SystemIdentity } from './types.js';

interface IdentityRow {
  id: string; email: string; name: string; emailVerified: number; createdAt: string | number;
  role: AdminRole | null; disabled: number; ever_activated: number;
  valid_until: string | null; sharing_eligible: number;
}
interface CodeRow {
  id: string; digest: string; validity_days: number; redeem_before: string | null;
  created_at: string; created_by: string; note: string; revoked_at: string | null;
  redeemed_at: string | null; redeemed_by: string | null;
}
const identitySelect = `SELECT u.id,u.email,u.name,u.emailVerified,u.createdAt,a.disabled,a.ever_activated,
  a.valid_until,a.sharing_eligible,adm.role FROM user u
  JOIN system_accounts a ON a.user_id=u.id LEFT JOIN system_administrators adm ON adm.user_id=u.id`;
const digestCode = (code: string) => createHash('sha256').update(code.trim()).digest('hex');

export class SystemStore {
  constructor(readonly db: Database.Database, readonly now: () => Date = () => new Date()) {}

  getIdentity(id: string): SystemIdentity | null {
    const row = this.db.prepare(`${identitySelect} WHERE u.id=?`).get(id) as IdentityRow | undefined;
    return row ? this.identity(row) : null;
  }

  getIdentityByEmail(email: string): SystemIdentity | null {
    const row = this.db.prepare(`${identitySelect} WHERE lower(u.email)=lower(?)`).get(email.trim()) as IdentityRow | undefined;
    return row ? this.identity(row) : null;
  }

  sharingEligible(id: string): boolean {
    return Boolean((this.db.prepare('SELECT sharing_eligible FROM system_accounts WHERE user_id=?').get(id) as { sharing_eligible: number } | undefined)?.sharing_eligible);
  }

  private identity(row: IdentityRow): SystemIdentity {
    const cloudEligible = Boolean(row.emailVerified && !row.disabled && row.ever_activated
      && row.valid_until && Date.parse(row.valid_until) > this.now().getTime());
    return { id: row.id, email: row.email, name: row.name, createdAt: new Date(row.createdAt).toISOString(), emailVerified: Boolean(row.emailVerified),
      role: row.role, disabled: Boolean(row.disabled), everActivated: Boolean(row.ever_activated),
      validUntil: row.valid_until, cloudEligible,
      sharingEnabled: cloudEligible && Boolean(row.sharing_eligible), localExpiryPolicy: 'pending' };
  }

  listUsers(query: ListQuery, sharingOnly = false): ListResult<SystemIdentity & { sharingEligible: boolean }> {
    const where = `WHERE (u.email LIKE ? OR u.name LIKE ?)${sharingOnly ? ' AND a.sharing_eligible=1' : ''}`;
    const args = [`%${query.q ?? ''}%`, `%${query.q ?? ''}%`];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM user u JOIN system_accounts a ON a.user_id=u.id ${where}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`${identitySelect} ${where} ORDER BY u.createdAt DESC,u.id LIMIT ? OFFSET ?`)
      .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as IdentityRow[];
    return { data: rows.map(row => ({ ...this.identity(row), sharingEligible: Boolean(row.sharing_eligible) })), total };
  }

  audit(input: AuditInput): void {
    // Callers supply only explicitly whitelisted metadata; never bodies, tokens, drafts or codes.
    this.db.prepare(`INSERT INTO system_audit(id,actor_id,action,target_type,target_id,metadata,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.actorId, input.action, input.targetType, input.targetId, JSON.stringify(input.metadata ?? {}), this.now().toISOString());
  }

  listAudit(query: ListQuery) {
    const where = `WHERE action LIKE ? OR target_id LIKE ?`;
    const args = [`%${query.q ?? ''}%`, `%${query.q ?? ''}%`];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM system_audit ${where}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT id,actor_id AS actorId,action,target_type AS targetType,target_id AS targetId,metadata,created_at AS createdAt
      FROM system_audit ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(...args, query.pageSize, (query.page - 1) * query.pageSize) as Array<Record<string, unknown> & { metadata: string }>;
    return { data: rows.map(row => ({ ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> })), total };
  }

  updateUser(actor: SystemIdentity, id: string, changes: { disabled?: boolean; sharingEligible?: boolean }) {
    return this.db.transaction(() => {
      const target = this.getIdentity(id);
      if (!target) throw new SystemError(404, 'USER_NOT_FOUND', 'Account not found');
      if (target.role && actor.role !== 'superadmin') throw new SystemError(403, 'SUPERADMIN_REQUIRED', 'Only superadmin can modify administrator accounts');
      if (changes.disabled && target.role === 'superadmin') this.assertAnotherSuperadmin(id);
      if (changes.disabled !== undefined) this.db.prepare('UPDATE system_accounts SET disabled=? WHERE user_id=?').run(Number(changes.disabled), id);
      if (changes.sharingEligible !== undefined) this.db.prepare('UPDATE system_accounts SET sharing_eligible=? WHERE user_id=?').run(Number(changes.sharingEligible), id);
      if (changes.disabled) this.db.prepare('DELETE FROM session WHERE userId=?').run(id);
      this.audit({ actorId: actor.id, action: 'user.update', targetType: 'user', targetId: id, metadata: changes });
      return { ...this.getIdentity(id)!, sharingEligible: Boolean((this.db.prepare('SELECT sharing_eligible FROM system_accounts WHERE user_id=?').get(id) as { sharing_eligible: number }).sharing_eligible) };
    }).immediate();
  }

  revokeSessions(actor: SystemIdentity, id: string): number {
    return this.db.transaction(() => {
      const target = this.getIdentity(id);
      if (!target) throw new SystemError(404, 'USER_NOT_FOUND', 'Account not found');
      if (target.role && actor.role !== 'superadmin') throw new SystemError(403, 'SUPERADMIN_REQUIRED', 'Only superadmin can revoke administrator sessions');
      const count = this.db.prepare('DELETE FROM session WHERE userId=?').run(id).changes;
      this.audit({ actorId: actor.id, action: 'session.revoke', targetType: 'user', targetId: id, metadata: { count } });
      return count;
    }).immediate();
  }

  private assertAnotherSuperadmin(id: string) {
    const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM system_administrators adm JOIN system_accounts a ON a.user_id=adm.user_id
      WHERE adm.role='superadmin' AND a.disabled=0 AND adm.user_id<>?`).get(id) as { n: number }).n;
    if (!count) throw new SystemError(409, 'LAST_SUPERADMIN', 'The last enabled superadmin cannot be removed or disabled');
  }

  listAdmins(query: ListQuery) {
    const users = this.db.prepare(`${identitySelect} WHERE adm.role IS NOT NULL AND (u.email LIKE ? OR u.name LIKE ?) ORDER BY u.id LIMIT ? OFFSET ?`)
      .all(`%${query.q ?? ''}%`, `%${query.q ?? ''}%`, query.pageSize, (query.page - 1) * query.pageSize) as IdentityRow[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM system_administrators adm JOIN user u ON u.id=adm.user_id WHERE u.email LIKE ? OR u.name LIKE ?`)
      .get(`%${query.q ?? ''}%`, `%${query.q ?? ''}%`) as { n: number }).n;
    return { data: users.map(row => this.identity(row)), total };
  }

  setAdmin(actor: SystemIdentity, id: string, role: AdminRole | null): SystemIdentity {
    if (actor.role !== 'superadmin') throw new SystemError(403, 'SUPERADMIN_REQUIRED', 'Superadmin access required');
    return this.db.transaction(() => {
      const target = this.getIdentity(id);
      if (!target) throw new SystemError(404, 'USER_NOT_FOUND', 'Account not found');
      if (role && (!target.emailVerified || target.disabled)) throw new SystemError(409, 'ACCOUNT_NOT_READY', 'Administrator must be verified and enabled');
      if (target.role === 'superadmin' && role !== 'superadmin') this.assertAnotherSuperadmin(id);
      if (role) {
        const date = this.now().toISOString();
        this.db.prepare(`INSERT INTO system_administrators(user_id,role,created_at,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at`).run(id, role, date, date);
      } else this.db.prepare('DELETE FROM system_administrators WHERE user_id=?').run(id);
      // Privilege changes revoke existing sessions, including a changed administrator's own session.
      this.db.prepare('DELETE FROM session WHERE userId=?').run(id);
      this.audit({ actorId: actor.id, action: role ? 'admin.grant' : 'admin.revoke', targetType: 'user', targetId: id, metadata: { role } });
      return this.getIdentity(id)!;
    }).immediate();
  }

  createCodes(actorId: string, input: { count: number; validityDays: number; redeemBefore: string | null; note: string }) {
    return this.db.transaction(() => {
      const now = this.now().toISOString();
      const created: Array<ActivationCode & { code: string }> = [];
      for (let i = 0; i < input.count; i++) {
        const code = `ACT-${randomBytes(32).toString('base64url')}`;
        const id = randomUUID();
        this.db.prepare(`INSERT INTO system_activation_codes(id,digest,validity_days,redeem_before,created_at,created_by,note) VALUES(?,?,?,?,?,?,?)`)
          .run(id, digestCode(code), input.validityDays, input.redeemBefore, now, actorId, input.note);
        created.push({ ...this.codeView(this.db.prepare('SELECT * FROM system_activation_codes WHERE id=?').get(id) as CodeRow), code });
        this.audit({ actorId, action: 'activation.create', targetType: 'activation-code', targetId: id,
          metadata: { validityDays: input.validityDays, redeemBefore: input.redeemBefore } });
      }
      return { data: created };
    }).immediate();
  }

  private codeView(row: CodeRow): ActivationCode {
    return { id: row.id, validityDays: row.validity_days, redeemBefore: row.redeem_before,
      createdAt: row.created_at, createdBy: row.created_by, note: row.note,
      revokedAt: row.revoked_at, redeemedAt: row.redeemed_at, redeemedBy: row.redeemed_by,
      status: row.redeemed_at ? 'redeemed' : row.revoked_at ? 'revoked'
        : row.redeem_before && Date.parse(row.redeem_before) <= this.now().getTime() ? 'expired' : 'available' };
  }

  listCodes(query: ListQuery): ListResult<ActivationCode> {
    const args = [`%${query.q ?? ''}%`, `%${query.q ?? ''}%`];
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM system_activation_codes WHERE id LIKE ? OR note LIKE ?').get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM system_activation_codes WHERE id LIKE ? OR note LIKE ? ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as CodeRow[];
    return { data: rows.map(row => this.codeView(row)), total };
  }

  revokeCode(actorId: string, id: string): ActivationCode {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM system_activation_codes WHERE id=?').get(id) as CodeRow | undefined;
      if (!row) throw new SystemError(404, 'CODE_NOT_FOUND', 'Activation code not found');
      if (row.redeemed_at) throw new SystemError(409, 'CODE_REDEEMED', 'A redeemed code cannot be revoked');
      if (!row.revoked_at) {
        row.revoked_at = this.now().toISOString();
        this.db.prepare('UPDATE system_activation_codes SET revoked_at=? WHERE id=?').run(row.revoked_at, id);
        this.audit({ actorId, action: 'activation.revoke', targetType: 'activation-code', targetId: id });
      }
      return this.codeView(row);
    }).immediate();
  }

  redeemCode(userId: string, plaintext: string) {
    return this.db.transaction(() => {
      const identity = this.getIdentity(userId);
      if (!identity || identity.disabled || !identity.emailVerified) throw new SystemError(403, 'ACCOUNT_NOT_READY', 'Verified enabled account required');
      const row = this.db.prepare('SELECT * FROM system_activation_codes WHERE digest=?').get(digestCode(plaintext)) as CodeRow | undefined;
      if (!row) throw new SystemError(400, 'INVALID_ACTIVATION_CODE', 'Activation code is invalid or unavailable');
      const receipt = this.db.prepare(`SELECT id,code_id AS codeId,user_id AS userId,redeemed_at AS redeemedAt,valid_until AS validUntil
        FROM system_activation_receipts WHERE code_id=?`).get(row.id) as { id: string; codeId: string; userId: string; redeemedAt: string; validUntil: string } | undefined;
      // Same-account retries return the original receipt without extending entitlement again.
      if (receipt?.userId === userId) return { receipt, identity, alreadyRedeemed: true };
      const now = this.now();
      if (row.revoked_at || row.redeemed_at || (row.redeem_before && Date.parse(row.redeem_before) <= now.getTime())) {
        throw new SystemError(409, 'ACTIVATION_CODE_UNAVAILABLE', 'Activation code is invalid or unavailable');
      }
      // Each code's validity begins at redemption; no device binding and no implicit stacking.
      const validUntil = new Date(now.getTime() + row.validity_days * 86_400_000).toISOString();
      const currentUntil = identity.validUntil;
      const accountUntil = currentUntil && currentUntil > validUntil ? currentUntil : validUntil;
      const redeemedAt = now.toISOString();
      const claimed = this.db.prepare(`UPDATE system_activation_codes SET redeemed_at=?,redeemed_by=?
        WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL`).run(redeemedAt, userId, row.id).changes;
      if (claimed !== 1) throw new SystemError(409, 'ACTIVATION_CODE_UNAVAILABLE', 'Activation code is invalid or unavailable');
      const result = { id: randomUUID(), codeId: row.id, userId, redeemedAt, validUntil };
      this.db.prepare(`INSERT INTO system_activation_receipts(id,code_id,user_id,redeemed_at,valid_until) VALUES(?,?,?,?,?)`)
        .run(result.id, row.id, userId, redeemedAt, validUntil);
      this.db.prepare('UPDATE system_accounts SET ever_activated=1,valid_until=? WHERE user_id=?').run(accountUntil, userId);
      this.audit({ actorId: userId, action: 'activation.redeem', targetType: 'activation-code', targetId: row.id, metadata: { receiptId: result.id, validUntil } });
      return { receipt: result, identity: this.getIdentity(userId)!, alreadyRedeemed: false };
    }).immediate();
  }
}
