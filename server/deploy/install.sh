#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
source /etc/aistudio-studio/deploy.conf
export PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22 || major===22&&minor<20)throw Error("Node >=22.20 required")'
directory=$(cd -- "$(dirname -- "$0")" && pwd)
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_ROOT/home" --shell /sbin/nologin "$APP_USER"
install -d -m 0755 "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/tools"
install -d -m 0700 "$APP_ROOT/backups"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$APP_ROOT/home" "$DATA_ROOT" "$DATA_ROOT/private-media"
test -f /etc/aistudio-studio/system.env
chmod 0600 /etc/aistudio-studio/system.env
# Never replace the machine's Node/npm or other services' package managers.
npm install --prefix "$APP_ROOT/tools" --no-audit --no-fund pnpm@11.5.1
if [[ ! -d "$APP_ROOT/repository/.git" ]]; then
  git clone --branch main --single-branch "$REPOSITORY_URL" "$APP_ROOT/repository"
fi
install -m 0755 "$directory/deploy.sh" /usr/local/sbin/aistudio-studio-deploy
cat > /etc/systemd/system/aistudio-studio.service <<EOF
[Unit]
Description=AI Studio accounts, administration and shared projects
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=/etc/aistudio-studio/system.env
Environment=NODE_ENV=production
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN/node dist/system/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_ROOT

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/aistudio-studio-deploy.service <<EOF
[Unit]
Description=Check main and deploy AI Studio on change
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/aistudio-studio-deploy
TimeoutStartSec=20min
EOF
install -m 0644 "$directory/aistudio-studio-deploy.timer" /etc/systemd/system/aistudio-studio-deploy.timer
systemctl daemon-reload
systemctl enable aistudio-studio.service
echo 'Installed. Run aistudio-studio-deploy, then enable --now aistudio-studio-deploy.timer after verification.'
