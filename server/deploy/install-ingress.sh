#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]]
source /etc/aistudio-studio/deploy.conf
directory=$(cd -- "$(dirname -- "$0")" && pwd)
ingress_port=$(printenv SYSTEM_INGRESS_PORT || printf 3003)
[[ "$ingress_port" =~ ^[0-9]{4,5}$ ]] && (( ingress_port >= 1024 && ingress_port <= 65535 ))
unit="aistudio-studio-ingress@$ingress_port.service"
install -d -m 0755 "$APP_ROOT/ingress/$ingress_port"
if systemctl is-active --quiet "$unit"; then
  cmp "$directory/ingress.mjs" "$APP_ROOT/ingress/$ingress_port/ingress.mjs" || { echo 'Install on a new port and drain the old ingress before replacing it.' >&2; exit 1; }
else
  install -m 0644 "$directory/ingress.mjs" "$APP_ROOT/ingress/$ingress_port/ingress.mjs"
fi
cat > /etc/systemd/system/aistudio-studio-ingress@.service <<EOF
[Unit]
Description=AI Studio restart-safe loopback ingress
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
Environment=SYSTEM_PORT=$SYSTEM_PORT
Environment=SYSTEM_INGRESS_PORT=%i
ExecStart=$NODE_BIN/node $APP_ROOT/ingress/%i/ingress.mjs
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
systemctl enable --now "$unit"
if systemctl is-active --quiet aistudio-studio.service; then
  curl --silent --fail --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "http://127.0.0.1:$ingress_port/health" >/dev/null
fi
