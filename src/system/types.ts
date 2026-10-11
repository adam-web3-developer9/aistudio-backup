export const adminRoles = ['superadmin', 'operator', 'readonly'] as const;
export type AdminRole = typeof adminRoles[number];
export type AdminPermission = 'read' | 'operate' | 'authorize';

export interface SystemIdentity {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  role: AdminRole | null;
  disabled: boolean;
  everActivated: boolean;
  validUntil: string | null;
  cloudEligible: boolean;
  sharingEnabled: boolean;
  localExpiryPolicy: 'pending';
}

export interface SystemPrincipal extends SystemIdentity {
  sessionId: string;
  sharingEligible: boolean;
  adminRole: AdminRole | null;
}

export interface ListQuery { page: number; pageSize: number; q?: string }
export interface ListResult<T> { data: T[]; total: number }
export interface AuditInput {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}
export interface ActivationCode {
  id: string;
  validityDays: number;
  redeemBefore: string | null;
  createdAt: string;
  createdBy: string;
  note: string;
  revokedAt: string | null;
  redeemedAt: string | null;
  redeemedBy: string | null;
  status: 'available' | 'expired' | 'revoked' | 'redeemed';
}

export class SystemError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
    this.name = 'SystemError';
  }
}

export function assertAdmin(identity: SystemIdentity, permission: AdminPermission = 'read'): void {
  if (!identity.role) throw new SystemError(403, 'ADMIN_REQUIRED', 'Administrator access required');
  if (permission === 'operate' && identity.role === 'readonly') {
    throw new SystemError(403, 'READONLY', 'This administrator can only read records');
  }
  if (permission === 'authorize' && identity.role !== 'superadmin') {
    throw new SystemError(403, 'SUPERADMIN_REQUIRED', 'Superadmin access required');
  }
}
