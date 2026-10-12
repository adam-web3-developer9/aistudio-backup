# Studio production deployment

Site: https://studio.crypto-compass-web.online/admin/

The system service runs as `aistudio-studio` on loopback port 3001. It serves
accounts, administration, projects and private media on one HTTPS origin.
Channels remain disabled until their production accounts are configured.

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

The first administrator must already be registered and email-verified before an
authorized operator uses the offline bootstrap CLI in `src/system/README.md`.
The deployment does not create test accounts or bypass email verification.
