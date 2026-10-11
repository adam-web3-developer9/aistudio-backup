/**
 * Better Auth's internal API retains its native values. Only the public HTTP
 * bridge projects JSON responses: session credentials travel solely in cookies.
 * Verification/reset links use their original non-JSON redirects and mail flow.
 */
export function projectAuthHttpResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectAuthHttpResponse);
  if (!value || typeof value !== 'object') return value;
  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (['token', 'ipAddress', 'userAgent', 'accessToken', 'refreshToken', 'idToken'].includes(key)) continue;
    projected[key] = projectAuthHttpResponse(item);
  }
  return projected;
}
