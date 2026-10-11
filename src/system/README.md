# System identity module

`createSystemRuntime(options)` returns a persistent Better Auth + SQLite runtime.
`registerSystemRoutes(app, { runtime })` attaches authentication, activation and
administration endpoints. `buildSystemApp(options)` returns `{ app, runtime }`
for isolated tests and a service without browser/channel initialization.

The deployment entrypoint is `pnpm system:dev` / `pnpm system:start`. All mail
uses the injected `SystemMailer`; production configuration accepts SMTP only.
Tests inject `MemorySystemMailer` and never send real messages.

## Authentication and browser security

- `/api/auth/*` follows Better Auth's official Fastify Fetch bridge. Email signup
  requires verification; verification does not auto-login. Passwords are 12–128
  characters; reset revokes existing sessions.
- Authentication JSON responses are recursively projected to remove session
  tokens, IP addresses and user agents. Session credentials remain only in the
  HttpOnly cookies; internal Better Auth APIs and verification/reset links retain
  their native contract.
- `/api/system/me` is a safe flat identity: `id,email,name,createdAt,emailVerified,
  role,disabled,everActivated,validUntil,cloudEligible,sharingEnabled,
  localExpiryPolicy`. It contains no provider credentials, balances or sessions.
- The session is stored in SQLite and checked on every request with cookie cache
  disabled. Roles, eligibility and disable state are read afresh from SQLite.
- HTTPS uses Secure HttpOnly SameSite=Lax cookies. `NODE_ENV=production` rejects
  HTTP and disabled authentication rate limiting. Reverse-proxy trust must be
  configured explicitly by the deployment; this module does not trust forwarding
  headers to construct authentication links.
- `runtime.assertRequestOrigin(request)` must protect all related `/api/*`
  plugins. It checks exact trusted origins, rejects missing Origin on cookie
  writes, and requires JSON mutations. Clients send `{}` for empty mutations,
  including DELETE. `systemLoggerOptions` removes verification/reset query tokens
  and credentials from request logs. Keep `/admin` and `/api/*` on one origin.
- `runtime.authenticate(request)` throws 401/403 or returns a flat
  `SystemPrincipal` with `sessionId,sharingEligible,adminRole` for trusted server
  modules. `requireAdmin(request, 'read'|'operate'|'authorize')` checks live roles.
- Long-running workers must use `runtime.assertPrincipalCurrent({id,sessionId})`
  before each paid request, heartbeat, result/media persistence and completion.
  It checks the current SQLite session owner/expiry/revocation and account state,
  returning fresh cloud/sharing qualification. Project access then verifies the
  fresh qualification and current membership. Retained principal flags alone are
  insufficient.

## Activation and local usage

`POST /api/system/activate {code}` returns `{receipt,identity,alreadyRedeemed}`.
Codes have 256 bits of randomness and only SHA-256 digests persist. Creation
returns plaintext once. Lists, audit records and revocation never reveal codes.
`validityDays` defaults to 365 and starts at redemption. `redeemBefore` is an
independent deadline. Redemption is account-bound with no device binding.
Same-account retries return the original receipt. Different-account races have
one winner. Code claim, entitlement, receipt and audit commit in one IMMEDIATE
transaction. A new code grants its own duration from redemption, keeping the
later current expiry; durations do not silently stack.

`everActivated` survives expiry and restart, separately from `validUntil`.
There is no short offline lease or local lock. Local expiry policy remains
`pending`. `cloudEligible` requires verification, enabled account and current
activation; the sharing whitelist is independent and defaults to disabled.

## Administration API

All list responses use `{data,total}`. Query parameters are `page` (default 1),
`pageSize` (default 20, max 100), and `q`. Users accept `sharingEligible=true`.
Errors use `{code,message}`; validation adds non-sensitive field errors.

| Route | Method | Permission / request |
| --- | --- | --- |
| `/api/admin/me` | GET | Any administrator |
| `/api/admin/users` | GET | Any administrator |
| `/api/admin/users/:id` | PATCH | Operate; `{disabled?,sharingEligible?}` |
| `/api/admin/users/:id/revoke-sessions` | POST | Operate; `{}` |
| `/api/admin/sharing-whitelist` | GET | Any administrator |
| `/api/admin/sharing-whitelist/:id` | PUT / DELETE | Operate; `{}` |
| `/api/admin/activation-codes` | GET | Any administrator |
| `/api/admin/activation-codes` | POST | Operate; `{count?:1..100,validityDays?:1..3650,redeemBefore?:ISO|null,note?:string}` |
| `/api/admin/activation-codes/:id/revoke` | POST | Operate; `{}` |
| `/api/admin/audit` | GET | Any administrator |
| `/api/admin/admins` | GET | Authorize |
| `/api/admin/admins/:id` | PUT / DELETE | Authorize; PUT `{role:'superadmin'|'operator'|'readonly'}` |

Readonly may only read. Operator may operate ordinary accounts and codes, but
cannot authorize roles or modify administrator accounts. Only superadmin can
grant/revoke administrator roles. Changes revoke target sessions. The last
enabled superadmin cannot be disabled or removed. No public administrator signup
or impersonation endpoint exists. Project drafts are not part of these APIs.

## First administrator (offline deployment step)

First register and verify the intended account through the normal email flow.
An authorized deployment operator then runs the offline CLI on the explicit
existing database. This code is provided for later deployment; implementing it
does not authorize executing it against production.

```sh
node --import tsx scripts/bootstrap-admin.mjs \
  --database /absolute/path/to/system.sqlite \
  --email existing-verified-account@example.com \
  --confirm GRANT_FIRST_SUPERADMIN
```

`--user-id` may replace `--email`. The CLI requires zero existing superadmins,
an existing verified enabled target, and an explicit confirmation. It creates no
user or credentials, reads no environment auth secret, sends no mail, starts no
listener, and records grant + session revocation + audit in one transaction.
Subsequent administrator changes use the authorized admin API.

For isolated fixtures only, set `SYSTEM_BOOTSTRAP_LOCAL_TEST=1`,
`SYSTEM_BOOTSTRAP_TEST_DATABASE` to a new `/tmp` database,
`SYSTEM_BOOTSTRAP_TEST_EMAIL` to a reserved `.test`/`.invalid` address and
`SYSTEM_BOOTSTRAP_TEST_PASSWORD` to a test-only password. The fixture helper
refuses existing databases, production mode, real email domains and symlink
escapes. Run `pnpm system:bootstrap-local-test`. Never reuse this mode for a
deployment administrator.
