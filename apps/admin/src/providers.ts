import type { AuthProvider, DataProvider, HttpError } from "@refinedev/core";

export type Role = "superadmin" | "operator" | "readonly";
export interface AdminIdentity {
  id: string;
  email: string;
  name?: string;
  role: Role;
}
export class ApiError extends Error implements HttpError {
  statusCode: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = status;
    this.code = code;
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.message ||
        body?.error?.message ||
        `请求失败（HTTP ${response.status}）`,
      response.status,
      body?.code ?? body?.error?.code,
    );
  if (!body && response.status !== 204)
    throw new ApiError("服务返回了无法识别的数据，请检查 API 地址。", 502);
  return body as T;
}
export function mutation<T>(path: string, method: string, body?: unknown) {
  return request<T>(path, {
    method,
    body: JSON.stringify(body ?? {}),
  });
}
export type ChannelBatchAction = "enable" | "disable" | "archive" | "restore";
export interface ChannelStatistics {
  total: number;
  enabled: number;
  disabled: number;
  archived: number;
  usable: number | null;
  usableCredits: number | null;
  unchecked: number;
  failed: number;
  lowCredit: number | null;
  minimumCredits: number | null;
  minimumVideoCount: number | null;
  lastCheckedAt: string | null;
}
export interface ChannelBatchResult {
  updated: number;
  accounts: Record<string, unknown>[];
}
export interface ChannelBatchItem {
  id: string;
  status: "succeeded" | "failed" | "unconfirmed";
  code?: string;
  message?: string;
}
export interface ChannelBatchSummary {
  results: ChannelBatchItem[];
  total: number;
  succeeded: number;
  failed: number;
  unconfirmed: number;
  error?: unknown;
}
export interface ChannelCleanupResult {
  checked: number;
  archived: number;
  retained: number;
  failed: number;
  unprocessed?: number;
  error?: unknown;
}
const CHANNEL_WINDOW_SIZE = 500;
export async function selectChannelAccountIds(q: string, onProgress?: (count: number) => void, unarchivedOnly = false) {
  const ids = new Set<string>();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const query = new URLSearchParams({ q, page: String(page), pageSize: "200" });
    const response = await request<{ data: {id: string; archivedAt?: string | null}[]; total: number }>(`/api/admin/channels/accounts?${query}`);
    if (page === 1) pages = Math.ceil(response.total / 200);
    for (const row of response.data) if (!unarchivedOnly || !row.archivedAt) ids.add(row.id);
    onProgress?.(ids.size);
  }
  return [...ids];
}
export function summarizeChannelBatch(results: ChannelBatchItem[], error?: unknown): ChannelBatchSummary {
  return { results, total: results.length, succeeded: results.filter(item => item.status === "succeeded").length,
    failed: results.filter(item => item.status === "failed").length, unconfirmed: results.filter(item => item.status === "unconfirmed").length, error };
}
export async function batchChannelAccounts(ids: string[], action: ChannelBatchAction, onProgress?: (summary: ChannelBatchSummary) => void) {
  const selected = [...new Set(ids)];
  const results: ChannelBatchItem[] = selected.map(id => ({id, status: "unconfirmed"}));
  let error: unknown;
  for (let offset = 0; offset < selected.length; offset += CHANNEL_WINDOW_SIZE) {
    const window = selected.slice(offset, offset + CHANNEL_WINDOW_SIZE);
    try {
      const response = await mutation<ChannelBatchResult & { results: ChannelBatchItem[] }>("/api/admin/channels/accounts/batch", "POST", {ids: window, action, partial: true});
      const receipts = new Map(response.results?.map(item => [item.id, item]));
      if (receipts.size !== window.length || window.some(id => !["succeeded", "failed"].includes(receipts.get(id)?.status ?? "")))
        throw new ApiError("服务未返回完整的逐项结果，请重试尚未确认的账户。", 502);
      for (let index = 0; index < window.length; index++) results[offset + index] = receipts.get(window[index])!;
      onProgress?.(summarizeChannelBatch([...results]));
    } catch (cause) {
      error = cause;
      const message = cause instanceof Error ? cause.message : "请求失败，尚未确认完成。";
      for (let index = offset; index < results.length; index++) results[index] = {...results[index], message: index < offset + window.length ? message : "上一批请求失败，尚未提交。"};
      break;
    }
  }
  return summarizeChannelBatch(results, error);
}
export async function cleanupChannelAccounts(ids?: string[]) {
  const selected = [...new Set(ids ?? await selectChannelAccountIds("", undefined, true))];
  const total: ChannelCleanupResult = {checked: 0, archived: 0, retained: 0, failed: 0, unprocessed: 0};
  for (let offset = 0; offset < selected.length; offset += CHANNEL_WINDOW_SIZE) {
    try {
      const result = await mutation<ChannelCleanupResult>("/api/admin/channels/accounts/cleanup", "POST", {ids: selected.slice(offset, offset + CHANNEL_WINDOW_SIZE)});
      for (const key of ["checked", "archived", "retained", "failed"] as const) total[key] += result[key];
    } catch (error) { total.error = error; total.unprocessed = selected.length - offset; break; }
  }
  return total;
}
export async function createActivationCodes(input: {count: number; validityDays: number; redeemBefore: string | null; note?: string}, onProgress?: (created: number) => void) {
  if (!Number.isSafeInteger(input.count) || input.count < 1) throw new ApiError("数量必须为正整数。", 400);
  const data: (Record<string, any> & {id: string})[] = [];
  for (let offset = 0; offset < input.count; offset += 100) {
    const count = Math.min(100, input.count - offset);
    try {
      const result = await mutation<{data: (Record<string, any> & {id: string})[]}>("/api/admin/activation-codes", "POST", {...input,count});
      data.push(...result.data);
      if (result.data.length !== count) throw new ApiError("服务未返回当前批次全部激活码。", 502);
      onProgress?.(data.length);
    } catch (error) {
      // Plaintext codes return once: an uncertain creation window must not be resent silently.
      return {data, unconfirmed: count, unsubmitted: input.count-offset-count, error};
    }
  }
  return {data, unconfirmed: 0, unsubmitted: 0, error: undefined};
}
export async function getAdmin(): Promise<AdminIdentity> {
  const identity = await request<AdminIdentity>("/api/admin/me");
  if (!["superadmin", "operator", "readonly"].includes(identity.role))
    throw new ApiError("此账户没有管理后台权限。", 403);
  return identity;
}
export const authProvider: AuthProvider = {
  login: async ({ email, password }: { email: string; password: string }) => {
    try {
      await mutation("/api/auth/sign-in/email", "POST", { email, password });
      await getAdmin();
      return { success: true };
    } catch (error) {
      return { success: false, error: error as Error };
    }
  },
  logout: async () => {
    try {
      await mutation("/api/auth/sign-out", "POST", {});
      return { success: true };
    } catch (error) {
      return { success: false, error: error as Error };
    }
  },
  check: async () => {
    try {
      await getAdmin();
      return { authenticated: true };
    } catch (error) {
      return {
        authenticated: false,
        error: error as Error,
        logout:
          error instanceof ApiError && [401, 403].includes(error.statusCode),
      };
    }
  },
  getIdentity: getAdmin,
  getPermissions: async () => (await getAdmin()).role,
  onError: async (error) => ({ logout: error.statusCode === 401 }),
};
export const dataProvider: DataProvider = {
  getApiUrl: () => "/api/admin",
  getList: async ({ resource, pagination, filters, sorters }) => {
    const query = new URLSearchParams({
      page: String(pagination?.currentPage ?? 1),
      pageSize: String(pagination?.pageSize ?? 20),
    });
    for (const filter of filters ?? [])
      if (
        "field" in filter &&
        filter.value !== undefined &&
        filter.value !== ""
      )
        query.set(filter.field, String(filter.value));
    if (sorters?.[0]) {
      query.set("sortBy", sorters[0].field);
      query.set("sortOrder", sorters[0].order);
    }
    return request(`/api/admin/${resource}?${query}`);
  },
  getOne: async ({ resource, id }) => ({
    data: await request(
      `/api/admin/${resource}/${encodeURIComponent(String(id))}`,
    ),
  }),
  create: async ({ resource, variables }) => ({
    data: await mutation(`/api/admin/${resource}`, "POST", variables),
  }),
  update: async ({ resource, id, variables }) => ({
    data: await mutation(
      `/api/admin/${resource}/${encodeURIComponent(String(id))}`,
      "PATCH",
      variables,
    ),
  }),
  deleteOne: async ({ resource, id }) => ({
    data: await mutation(
      `/api/admin/${resource}/${encodeURIComponent(String(id))}`,
      "DELETE",
    ),
  }),
};
