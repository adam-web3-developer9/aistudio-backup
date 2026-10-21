#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]]
source /etc/aistudio-studio/deploy.conf
directory=$(cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 "$APP_ROOT/ingress"
if systemctl is-active --quiet aistudio-studio-ingress.service; then
  cmp "$directory/ingress.mjs" "$APP_ROOT/ingress/ingress.mjs" || { echo 'Ingress changes require a separate drain window.' >&2; exit 1; }
else
  install -m 0644 "$directory/ingress.mjs" "$APP_ROOT/ingress/ingress.mjs"
fi
cat > /etc/systemd/system/aistudio-studio-ingress.service <<EOF
[Unit]
Description=AI Studio restart-safe loopback ingress
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
Environment=SYSTEM_PORT=$SYSTEM_PORT
Environment=SYSTEM_INGRESS_PORT=3002
ExecStart=$NODE_BIN/node $APP_ROOT/ingress/ingress.mjs
Restart=on-failure
RestartSec=1
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aistudio-studio-ingress.service
if systemctl is-active --quiet aistudio-studio.service; then
  curl --silent --fail --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 http://127.0.0.1:3002/health >/dev/null
fi
