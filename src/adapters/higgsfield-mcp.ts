import { createHash, randomBytes } from 'node:crypto';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

/**
 * Higgsfield's official machine interface: an MCP server over HTTP at
 * `https://mcp.higgsfield.ai/mcp`.
 *
 * This replaces the web app's own gateway (`fnf-api-gw.higgsfield.ai`) as this
 * channel's transport, for two reasons found the hard way:
 *
 *  - `/jobs/*` on that gateway sits behind DataDome. Node is turned away with a
 *    Cloudflare challenge, and a real browser page gets DataDome's own
 *    "enable JS" interstitial until someone solves a captcha — per session.
 *  - Trial accounts are refused there outright, with the platform naming the
 *    remedy: `only_mcp_usage_on_trial_is_available`.
 *
 * The MCP endpoint has none of that, and gives more than the gateway did: an
 * exact, free cost preflight (`generate_video` with `get_cost`), the parameter
 * schema of every model (`models_explore`), and a credit ledger
 * (`transactions`).
 *
 * Two quirks shape the code below. Responses are MCP tool results whose payload
 * is **prose written for a human** with the ids embedded in it, so the parsing
 * here is deliberately forgiving: structured fields first, then a regex over the
 * text. And the server refuses a `chrome-extension://` origin, so callers send a
 * site origin — harmless from Node, but it is why the header is set at all.
 */
export const HIGGSFIELD_MCP_ORIGIN = 'https://mcp.higgsfield.ai';
export const HIGGSFIELD_MCP_ENDPOINT = `${HIGGSFIELD_MCP_ORIGIN}/mcp`;
export const HIGGSFIELD_OAUTH_REGISTER = `${HIGGSFIELD_MCP_ORIGIN}/oauth2/register`;
export const HIGGSFIELD_OAUTH_AUTHORIZE = `${HIGGSFIELD_MCP_ORIGIN}/oauth2/authorize`;
export const HIGGSFIELD_OAUTH_TOKEN = `${HIGGSFIELD_MCP_ORIGIN}/oauth2/token`;
export const HIGGSFIELD_OAUTH_SCOPE = 'openid email offline_access';

/** The site origin the MCP server expects; see the note above. */
const CALLER_ORIGIN = 'https://higgsfield.ai';

let dispatcher: Dispatcher | undefined;

export function useHiggsfieldMcpProxy(proxyUrl?: string): void {
  dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export class HiggsfieldMcpError extends Error {
  constructor(readonly status: number, message: string, readonly tool?: string) {
    super(message);
    this.name = 'HiggsfieldMcpError';
  }
}

/** An account's OAuth credential. Only `refreshToken` has to survive a restart. */
export interface HiggsfieldOAuthTokens {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; refreshed a little before this. */
  expiresAt?: number;
  /**
   * The OpenID token, when the server issued one. It is never sent anywhere —
   * it is only where the account's email and user id come from, because the
   * access token carries neither.
   */
  idToken?: string;
}

/* -------------------------------------------------------------------------- */
/* OAuth                                                                       */
/* -------------------------------------------------------------------------- */

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

/** PKCE pair: the verifier is kept, the challenge goes in the authorize URL. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

/**
 * Register a public client. Higgsfield allows dynamic registration, so every
 * install gets its own `client_id` and there is no shared secret to keep — the
 * authorization code is protected by PKCE alone.
 */
export async function registerOAuthClient(
  redirectUri: string,
  clientName = 'hailuo gateway'
): Promise<{ clientId: string }> {
  const response = await fetch(HIGGSFIELD_OAUTH_REGISTER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }),
    dispatcher
  });
  const text = await response.text();
  if (!response.ok) throw new HiggsfieldMcpError(response.status, `OAuth client registration failed: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as { client_id?: string };
  if (!payload.client_id) throw new HiggsfieldMcpError(response.status, 'OAuth registration returned no client_id');
  return { clientId: payload.client_id };
}

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  /** Pre-fills the account on the provider's login page. */
  loginHint?: string;
  /** Always ask for credentials, so a previous account is not silently reused. */
  forceLogin?: boolean;
}): string {
  const url = new URL(HIGGSFIELD_OAUTH_AUTHORIZE);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: HIGGSFIELD_OAUTH_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state
  };
  if (input.loginHint) params.login_hint = input.loginHint;
  if (input.forceLogin) params.prompt = 'login';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<HiggsfieldOAuthTokens & { raw: Record<string, unknown> }> {
  const response = await fetch(HIGGSFIELD_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    dispatcher
  });
  const text = await response.text();
  if (!response.ok) throw new HiggsfieldMcpError(response.status, `OAuth token request failed: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) throw new HiggsfieldMcpError(response.status, 'OAuth token response carried no access_token');
  return {
    clientId: body.client_id!,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    raw: payload as Record<string, unknown>
  };
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<HiggsfieldOAuthTokens> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier
  });
}

export async function refreshAccessToken(tokens: HiggsfieldOAuthTokens): Promise<HiggsfieldOAuthTokens> {
  if (!tokens.refreshToken) throw new HiggsfieldMcpError(400, 'This account has no refresh token; sign it in again');
  const refreshed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId
  });
  // A server that rotates refresh tokens returns a new one; one that does not
  // returns none, and the old one stays valid.
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
}

/** The account's identity, read from the access token without a network call. */
export function describeMcpToken(accessToken: string): { userId?: string; email?: string; expiresAt?: number } {
  const part = accessToken.split('.')[1];
  if (!part) return {};
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      userId: typeof claims.sub === 'string' ? claims.sub : undefined,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
    };
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/* Carrying a credential through the session store                             */
/* -------------------------------------------------------------------------- */

/**
 * The account pool moves credentials around as browser cookies, because that is
 * what the other two channels store. Nothing here is ever sent to a browser:
 * these are just the fields of an OAuth credential under cookie names, so one
 * account record can hold it.
 */
export const HIGGSFIELD_MCP_CLIENT_COOKIE = 'hf_mcp_client';
export const HIGGSFIELD_MCP_REFRESH_COOKIE = 'hf_mcp_refresh';
export const HIGGSFIELD_MCP_ACCESS_COOKIE = 'hf_mcp_access';
export const HIGGSFIELD_MCP_ID_COOKIE = 'hf_mcp_id';
export const HIGGSFIELD_MCP_EXPIRES_COOKIE = 'hf_mcp_expires';

export interface McpCookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function higgsfieldMcpCookies(tokens: HiggsfieldOAuthTokens, origin: string): McpCookieLike[] {
  const domain = new URL(origin).hostname;
  const base = { domain, path: '/', secure: true, sameSite: 'Lax' as const };
  const cookies: McpCookieLike[] = [{ name: HIGGSFIELD_MCP_CLIENT_COOKIE, value: tokens.clientId, ...base }];
  if (tokens.refreshToken) cookies.push({ name: HIGGSFIELD_MCP_REFRESH_COOKIE, value: tokens.refreshToken, ...base });
  if (tokens.accessToken) cookies.push({ name: HIGGSFIELD_MCP_ACCESS_COOKIE, value: tokens.accessToken, ...base });
  if (tokens.idToken) cookies.push({ name: HIGGSFIELD_MCP_ID_COOKIE, value: tokens.idToken, ...base });
  if (tokens.expiresAt) cookies.push({ name: HIGGSFIELD_MCP_EXPIRES_COOKIE, value: String(tokens.expiresAt), ...base });
  return cookies;
}

export function readHiggsfieldMcpTokens(
  cookies: readonly { name: string; value: string }[]
): HiggsfieldOAuthTokens | undefined {
  const value = (name: string) => cookies.find((cookie) => cookie.name === name)?.value || undefined;
  const clientId = value(HIGGSFIELD_MCP_CLIENT_COOKIE);
  const refreshToken = value(HIGGSFIELD_MCP_REFRESH_COOKIE);
  const accessToken = value(HIGGSFIELD_MCP_ACCESS_COOKIE);
  const idToken = value(HIGGSFIELD_MCP_ID_COOKIE);
  if (!clientId || !(refreshToken || accessToken)) return undefined;
  const expiresAt = Number(value(HIGGSFIELD_MCP_EXPIRES_COOKIE));
  return {
    clientId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {})
  };
}

/* -------------------------------------------------------------------------- */
/* JSON-RPC over HTTP                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One MCP session against one account.
 *
 * Tokens are refreshed lazily: before a call when the expiry is known to be
 * near, and once more after a 401, because an access token can lapse mid-flight.
 */
export class HiggsfieldMcpSession {
  private nextId = 1;
  private refreshing?: Promise<void>;

  constructor(
    private tokens: HiggsfieldOAuthTokens,
    /** Called whenever tokens change, so the account file can be rewritten. */
    private readonly onTokens?: (tokens: HiggsfieldOAuthTokens) => void,
    private readonly refreshBeforeMs = 60_000
  ) {}

  get credentials(): HiggsfieldOAuthTokens {
    return this.tokens;
  }

  private async accessToken(): Promise<string> {
    const { accessToken, expiresAt } = this.tokens;
    const stale = !accessToken || (expiresAt !== undefined && expiresAt - Date.now() < this.refreshBeforeMs);
    if (stale) await this.refresh();
    const token = this.tokens.accessToken;
    if (!token) throw new HiggsfieldMcpError(401, 'No usable access token for this Higgsfield account');
    return token;
  }

  /** Concurrent callers share one refresh. */
  private async refresh(): Promise<void> {
    this.refreshing ??= refreshAccessToken(this.tokens)
      .then((tokens) => {
        this.tokens = tokens;
        this.onTokens?.(tokens);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }

  async rpc<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      const response = await fetch(HIGGSFIELD_MCP_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: CALLER_ORIGIN,
          referer: `${CALLER_ORIGIN}/`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        dispatcher,
        signal
      });
      const text = await response.text();

      if (response.status === 401 && attempt === 0) {
        attempt += 1;
        await this.refresh();
        continue;
      }
      if (!response.ok) throw new HiggsfieldMcpError(response.status, text.slice(0, 400));

      const payload = parseRpcBody(text);
      const error = (payload as { error?: { message?: string } }).error;
      if (error) throw new HiggsfieldMcpError(response.status, error.message ?? JSON.stringify(error));
      return (payload as { result?: T }).result as T;
    }
  }

  /**
   * Call a tool and hand back whatever it said.
   *
   * The server answers with `content[].text`, usually prose that happens to
   * contain JSON or ids; `structuredContent` is returned when present. Callers
   * use the readers below rather than assuming a shape.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpToolResult> {
    const result = await this.rpc<{
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    }>('tools/call', { name, arguments: args }, signal);

    const text = result?.content?.find((part) => part.type === 'text')?.text ?? '';
    if (result?.isError) throw new HiggsfieldMcpError(200, text.slice(0, 400) || `${name} failed`, name);
    return { text, structured: result?.structuredContent, tool: name };
  }
}

export interface McpToolResult {
  /** What the tool said, verbatim. Often prose with ids embedded. */
  text: string;
  structured?: unknown;
  tool: string;
}

/** Streamable HTTP frames the JSON in SSE `data:` lines; plain JSON also occurs. */
export function parseRpcBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        // Keep looking: a frame can be split across events.
      }
    }
    throw new HiggsfieldMcpError(502, `MCP returned a body that is not JSON: ${text.slice(0, 200)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Readers for the prose the tools answer with                                 */
/* -------------------------------------------------------------------------- */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Whatever JSON the tool embedded, when it embedded any. */
export function readJson(result: McpToolResult): unknown {
  if (result.structured !== undefined) return result.structured;
  try {
    return JSON.parse(result.text);
  } catch {
    return undefined;
  }
}

/** The first id in the text — what `generate_video` and `media_upload` hand back. */
export function readId(result: McpToolResult): string | undefined {
  return UUID.exec(result.text)?.[0];
}

/** Every id in the text, in order; a batch answers with one line each. */
export function readIds(result: McpToolResult): string[] {
  return [...result.text.matchAll(new RegExp(UUID.source, 'gi'))].map((match) => match[0]);
}

/** `media_upload` answers with a curl command; the presigned URL is inside it. */
export function readUpload(result: McpToolResult): { mediaId: string; uploadUrl: string } {
  const structured = readJson(result) as
    | { uploads?: Array<{ media_id?: string; id?: string; upload_url?: string }> }
    | undefined;
  const first = structured?.uploads?.[0];
  if (first?.upload_url && (first.media_id ?? first.id)) {
    return { mediaId: (first.media_id ?? first.id)!, uploadUrl: first.upload_url };
  }
  const match = new RegExp(`(${UUID.source})[\\s\\S]*?'(https://[^']+)'`, 'i').exec(result.text);
  if (!match) throw new HiggsfieldMcpError(200, `media_upload gave no upload URL: ${result.text.slice(0, 200)}`, 'media_upload');
  return { mediaId: match[1]!, uploadUrl: match[2]! };
}

/** `balance` answers `Credits: 96 | Plan: plus`. */
export function readCredits(result: McpToolResult): { credits: number; plan?: string } {
  const structured = readJson(result) as { credits?: unknown; plan?: unknown } | undefined;
  if (typeof structured?.credits === 'number') {
    return { credits: structured.credits, plan: typeof structured.plan === 'string' ? structured.plan : undefined };
  }
  const credits = /credits?\s*[:：]\s*(-?[\d.]+)/i.exec(result.text);
  if (!credits) throw new HiggsfieldMcpError(200, `balance gave no number: ${result.text.slice(0, 200)}`, 'balance');
  return { credits: Number(credits[1]), plan: /plan\s*[:：]\s*([\w-]+)/i.exec(result.text)?.[1] };
}

/** `generate_video` with `get_cost` answers `... 14 credits (14 exact) ...`. */
export function readCost(result: McpToolResult): number | undefined {
  const structured = readJson(result) as { cost?: unknown; credits?: unknown } | undefined;
  for (const value of [structured?.cost, structured?.credits]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const match = /(-?[\d.]+)\s*credits?/i.exec(result.text);
  return match ? Number(match[1]) : undefined;
}

/** `job_status` answers `Job <id> — completed` plus, when done, a URL. */
export function readJobStatus(result: McpToolResult): { status?: string; url?: string } {
  const structured = readJson(result) as { status?: unknown; url?: unknown } | undefined;
  const status = typeof structured?.status === 'string'
    ? structured.status
    : /\b(queued|in[_ ]progress|processing|running|completed|failed|nsfw|canceled|cancelled)\b/i
      .exec(result.text)?.[1]?.toLowerCase().replace(' ', '_');
  const url = typeof structured?.url === 'string'
    ? structured.url
    : /https?:\/\/[^\s"',]+\.(?:mp4|mov|webm|m4v)/i.exec(result.text)?.[0];
  return { status, url };
}
