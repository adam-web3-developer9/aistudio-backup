#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
directory=$(cd -- "$(dirname -- "$0")" && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/var/backups/aistudio-studio-https/$stamp"
mkdir -p "$backup"
exec 9>/run/lock/aistudio-shared-certificate.lock
flock 9
config=/www/server/panel/vhost/nginx/studio.crypto-compass-web.online.conf
hook=/usr/local/sbin/aistudio-shared-certificate-deploy
[[ ! -f "$config" ]] || cp -p "$config" "$backup/studio.conf"
cp -p "$hook" "$backup/certificate-deploy"
cp -p /root/.acme.sh/crypto-compass-web.online/crypto-compass-web.online.conf "$backup/acme.conf"
cert_directory=/www/server/panel/vhost/cert/crypto-compass-web.online-shared
for file in privkey.pem fullchain.pem incoming.key incoming.fullchain; do
  [[ ! -f "$cert_directory/$file" ]] || cp -p "$cert_directory/$file" "$backup/$file"
done
rollback() {
  trap - ERR INT TERM
  set +e
  cp -p "$backup/certificate-deploy" "$hook"
  cp -p "$backup/acme.conf" /root/.acme.sh/crypto-compass-web.online/crypto-compass-web.online.conf
  for file in privkey.pem fullchain.pem incoming.key incoming.fullchain; do
    [[ ! -f "$backup/$file" ]] || cp -p "$backup/$file" "$cert_directory/$file"
  done
  if [[ -f "$backup/studio.conf" ]]; then cp -p "$backup/studio.conf" "$config"; else rm -f "$config"; fi
  nginx -t && nginx -s reload
  echo "HTTPS update failed; prior configuration restored from $backup" >&2
  exit 1
}
trap rollback ERR INT TERM
# HTTP-01 must work for Studio before requesting expanded SAN coverage.
if [[ ! -f "$config" ]]; then
  cat > "$config" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name studio.crypto-compass-web.online;
    include /www/server/panel/vhost/nginx/crypto-compass-acme-location.inc;
    location / { return 503; }
}
EOF
fi
nginx -t
nginx -s reload
install -m 0755 "$directory/shared-certificate-deploy.py" "$hook"
# Keep all existing domains and the existing cron renewal / deploy hook.
/root/.acme.sh/acme.sh --issue --server letsencrypt --keylength 2048 \
  --webroot /www/wwwroot/aistudio-acme \
  -d crypto-compass-web.online -d www.crypto-compass-web.online \
  -d ai.crypto-compass-web.online -d proxy.crypto-compass-web.online \
  -d studio.crypto-compass-web.online
/root/.acme.sh/acme.sh --install-cert -d crypto-compass-web.online \
  --key-file /www/server/panel/vhost/cert/crypto-compass-web.online-shared/incoming.key \
  --fullchain-file /www/server/panel/vhost/cert/crypto-compass-web.online-shared/incoming.fullchain \
  --reloadcmd /usr/local/sbin/aistudio-shared-certificate-deploy
install -m 0644 "$directory/studio.nginx.conf" "$config"
nginx -t
nginx -s reload
trap - ERR INT TERM
echo 'Studio HTTPS installed; the existing shared-certificate cron renews all five domains.'
