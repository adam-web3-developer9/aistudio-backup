# Studio production deployment

Site: https://studio.crypto-compass-web.online/admin/

The system service runs as `aistudio-studio` on loopback port 3001. It serves
accounts, administration, projects and private media on one HTTPS origin.
Channels remain disabled until their production accounts are configured and the
gateway is explicitly enabled.

Nginx connects through the separate loopback ingress on port 3002. Install it
with install-ingress.sh and verify its health endpoint before switching an
existing Nginx upstream from 3001 to 3002 with a tested configuration reload.
The ingress is not restarted by application deployments. It holds new connections
for up to 90 seconds while the application is restarting, with a 1024-connection
limit. Only refused connections are retried, before any request bytes are
forwarded; requests already delivered to the application are never replayed.
It does not hide provider errors or guarantee availability beyond that bounded
wait. Updating an active ingress requires a separate drain window.

## First installation

Use the existing SSH helper / key. Upload this directory to a temporary server
directory; do not upload local `.env`, databases, provider accounts or browser
profiles. Run `bash configure.sh sender@qq.com` to initialize
`/etc/aistudio-studio/deploy.conf` and `system.env`, generate the auth secret once
and retain existing configuration on subsequent runs. Keep `system.env` mode
0600. For QQ mail use `smtp.qq.com:465`, secure TLS, the full QQ email as user
and sender, and its SMTP authorization code as password (not its login password).

Run `bash https.sh`, then `bash install.sh`, followed by
`/usr/local/sbin/aistudio-studio-deploy`. Verify HTTPS `/health`, `/admin/`, its
static assets and unauthenticated API rejection before enabling the poller:

```sh
systemctl enable --now aistudio-studio-deploy.timer
systemctl list-timers aistudio-studio-deploy.timer
journalctl -u aistudio-studio-deploy.service -n 50 --no-pager
```

The public repository is fetched through HTTPS without GitHub credentials.
Every minute the server compares `origin/main` with `deployed-commit`. A changed
commit is built in a separate release directory with locked backend and frontend
dependencies. The previous application continues running during the build.
Before activation the service stops and SQLite receives a consistent backup;
failed health checks restore both the previous release and its database backup.
Failed commits are recorded and skipped by later polls, preventing a broken
commit from causing repeated rebuilds or restarts. After correcting a transient
failure, retry with `/usr/local/sbin/aistudio-studio-deploy --force`; a new main
commit is attempted automatically.
Auth configuration, private media and SQLite live outside release directories.
Backups and releases are retained for operator review; monitor available disk.

First deployment requires network access to npm, GitHub and the existing ACME
provider. Node >=22.20 is required; installation uses a project-specific pnpm
10.34.7 (compatible with the v9 lockfile) without replacing the server's global
Node or package manager.

## HTTPS renewal

`https.sh` adds Studio to the existing shared SAN certificate while preserving
the apex, www, ai and proxy domains. `shared-certificate-deploy.py` validates
the exact five domains, validity and key match before atomic replacement,
`nginx -t` and reload. Existing renewal cron and ACME storage remain in use.
Deployment script / ACME config backups are stored under
`/var/backups/aistudio-studio-https`. Do not rerun certificate issuance for normal
code releases; the daily existing renewal job handles expiry.

## Operations

Detailed Miora diagnostics reuse the Node service logger. The repository also
contains optional, isolated retention examples:
`journald@aistudio-studio.conf.example` and
`aistudio-studio-logging.conf.example`. They do not run from `install.sh` or normal
code deployment and have not been installed on the live host. The example uses a
256 MiB persistent journal budget, 32 MiB fallback runtime budget, 16/4 MiB file
rotation, daily rotation and 14-day retention. The active journal file can remain
until the next rotation; retention is an operational journal budget rather than
an application business limit.

On a host supporting `LogNamespace` (systemd >=245), a separately authorized
maintenance window can copy the first example to
`/etc/systemd/journald@aistudio-studio.conf` and the second to
`/etc/systemd/system/aistudio-studio.service.d/logging.conf`, then reload systemd
and restart only Studio and its namespace journal. Do not change global
`/etc/systemd/journald.conf`; other services keep their own logging policy.
Reference: [systemd journal namespace configuration](https://github.com/systemd/systemd/blob/main/man/journald.conf.xml)
and [LogNamespace](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

The following commands are **an operator runbook, not executed by this change**:

```sh
systemd --version
install -m 0644 journald@aistudio-studio.conf.example /etc/systemd/journald@aistudio-studio.conf
install -d -m 0755 /etc/systemd/system/aistudio-studio.service.d
install -m 0644 aistudio-studio-logging.conf.example /etc/systemd/system/aistudio-studio.service.d/logging.conf
systemctl daemon-reload
systemctl restart systemd-journald@aistudio-studio.service
systemctl restart aistudio-studio.service
journalctl --namespace=aistudio-studio --disk-usage
journalctl --namespace=aistudio-studio -u aistudio-studio.service --utc -n 50 --no-pager
```

Before enabling the namespace, existing logs are in the default journal. Search
that journal separately for earlier failures. Application overflow/sink errors
are reported with `miora.diagnostics.dropped`; a flush runs after business
shutdown/record flushing, including the error path. Staged intent status polling
renews an active preparation lease. Status endpoints may resume pending imports,
so historical investigation must use already captured client errors, database
SELECTs or journals instead of triggering a real transfer through polling.

`systemctl status aistudio-studio.service` checks application health.
`cat /www/server/aistudio-studio/deployed-commit` shows the running revision.
`systemctl start aistudio-studio-deploy.service` requests an immediate main check.
Pause updates with `systemctl stop aistudio-studio-deploy.timer`.
After editing SMTP configuration, restart `aistudio-studio.service` and verify
SMTP authentication without printing credentials or sending a message:

```sh
cd /www/server/aistudio-studio/current
/www/server/nodejs/v22.22.3/bin/node --env-file=/etc/aistudio-studio/system.env scripts/verify-system-smtp.mjs
```

No successful mail delivery is implied by the application health endpoint.

## Enable the online Miora video gateway

Deploy a main revision containing `enable-video-gateway.py` before running this
one-time migration as root. Updating `system.env.example` or pushing main does
not modify the existing server's `system.env` and does not enable the gateway.

The server's Miora worker requires an explicit HTTP(S) proxy in
`MIORA_PROXY_URL`; Windows system proxy auto-detection and a direct default do
not configure an online gateway. Preserve an existing server proxy setting.
If it is missing, create a private server-only file, for example
`/etc/aistudio-studio/miora-proxy.env`, with mode `0600`. Enter the proxy URL in
that file, including any URL-encoded username/password. The permitted fields
are `MIORA_PROXY_URL`, optional `MIORA_PROXY_ADDRESS` (verified IP for DNS
pinning), and optional `MIORA_LOCAL_PROXY_URL`. No other settings can be imported
from this file. Keep it outside Git and never put its contents or the proxy URL
on a command line.

To reuse the existing local IPRoyal configuration, build the backend and run
`rtk node scripts/export-miora-server-proxy.mjs` in the local checkout. It writes
`tmp/miora-server-proxy.env` exclusively and prints only its filename. This
ignored file contains credentials: transfer it privately to the server path
above and set mode `0600`. Do not commit it or paste its contents into logs.
The enabled online gateway uses the configured proxy for generation and
progress queries and fails if that proxy is unavailable, without a direct
fallback. Local connectivity does not establish server connectivity.

```sh
cd /www/server/aistudio-studio/current
python3 server/deploy/enable-video-gateway.py --proxy-env-file /etc/aistudio-studio/miora-proxy.env
systemctl restart aistudio-studio.service
python3 server/deploy/enable-video-gateway.py --check
```

If `system.env` already contains `MIORA_PROXY_URL`, omit `--proxy-env-file`.
The script preserves existing nonempty proxy settings and rejects conflicting
file values. It validates the URL without printing it or its credentials;
query strings, fragments, arbitrary paths, unsupported schemes and invalid
ports are rejected. A newly supplied loopback URL requires
`--allow-loopback-proxy` to explicitly select a proxy running on the server.
An already configured server loopback proxy is retained. The migration does
not create a proxy service and does not invent a localhost proxy address.
Later deployments validate the configured proxy but cannot discover or
automatically supply its credentials.

The migration enables `SYSTEM_CHANNELS_ENABLED` and
`SYSTEM_VIDEO_GATEWAY_ENABLED` on the existing loopback port 3001. Nginx already
forwards `/v1/` to this service; a second worker or port is unnecessary. Video
jobs use the same enabled Miora accounts imported in the administration UI.
Import an account and enable it there before sending generation requests. The
gateway exposes asset uploads and Miora job submission/polling; provider session
management remains in the authenticated administration UI.

The script retains authentication/SMTP settings and existing gateway/vault keys.
It generates an `API_KEY` only when absent and requires 32 to 4096 visible ASCII
characters without spaces.
An existing short key causes a clear failure without changing the configuration.
Replace that short key explicitly with a strong key before retrying. A missing
`CHANNEL_CREDENTIAL_KEY` can be generated only when the database has no managed
accounts; otherwise restore the original key so existing encrypted credentials
remain readable. Keys are never printed by the migration. Retrieve `API_KEY`
privately from `/etc/aistudio-studio/system.env` for the authorized client.

Before replacing `system.env`, the script creates a private
`system.env.before-video-gateway-<UTC timestamp>` backup in the same directory.
It puts worker jobs/assets and legacy account/import files under
`DATA_ROOT/gateway`, with private permissions and ownership by `APP_USER`.
An already active worker using different paths is rejected so its recorded jobs
and credentials can be moved explicitly with the service stopped. Subsequent
deployments validate an enabled gateway, maintain its persistent directories and
require `/health` to report both `channelsEnabled` and `videoGatewayEnabled` true;
they do not generate replacement keys or silently enable a disabled gateway.
Existing systemd `ReadWritePaths=DATA_ROOT` already covers the gateway directory.

In the local AIStudio Miora video channel, set:

- Base URL: `https://studio.crypto-compass-web.online/v1`
- API Key: the server's `API_KEY`
- Adapter: `miora`; model: `minimax-h3`; resolution: `768P` or `2K`

The existing Miora pipeline requires a primary uploaded image asset. Upload
references through `/v1/assets` and submit their returned IDs; remote-only
references or an empty primary `assetId` are rejected.

The key authenticates this gateway; Miora `authToken` and refresh tokens stay in
the server's channel vault. After restart, verify HTTPS `/health`, unauthenticated
`/v1/jobs` rejection and an authenticated read of `/v1/jobs`. A successful health
check confirms service availability, not that an account can generate videos.
Only send a paid generation when explicitly requested.

To restore the pre-migration configuration, stop the service, copy the reported
backup over `/etc/aistudio-studio/system.env`, keep mode `0600`, and restart the
service. Retain `DATA_ROOT/gateway` so recorded tasks are available if the gateway
is enabled again. Do not rotate the vault key during rollback.

For isolated migration verification, use `--fixture-root /absolute/fixture`
together with `--config-directory /absolute/fixture/config`. Both fixture
`deploy.conf` and `system.env` must point only inside that root. Fixture mode
skips root/service ownership checks and never restarts services. `--check` is
read-only; `--maintain` prepares directories only when already enabled.

The first administrator must already be registered and email-verified before an
authorized operator uses the offline bootstrap CLI in `src/system/README.md`.
The deployment does not create test accounts or bypass email verification.
