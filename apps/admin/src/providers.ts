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
export interface ChannelBatchResult {
  updated: number;
  accounts: Record<string, unknown>[];
}
export interface ChannelCreditsResult {
  checked: number;
  succeeded: number;
  failed: number;
}
export interface ChannelCleanupResult {
  checked: number;
  archived: number;
  retained: number;
  failed: number;
}
export function batchChannelAccounts(ids: string[], action: ChannelBatchAction) {
  return mutation<ChannelBatchResult>("/api/admin/channels/accounts/batch", "POST", {
    ids,
    action,
  });
}
export function refreshChannelCredits(ids?: string[]) {
  return mutation<ChannelCreditsResult>("/api/admin/channels/accounts/credits/refresh", "POST", {
    ...(ids ? { ids } : {}),
  });
}
export function cleanupChannelAccounts(ids?: string[]) {
  return mutation<ChannelCleanupResult>("/api/admin/channels/accounts/cleanup", "POST", {
    ...(ids ? { ids } : {}),
  });
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
