#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
source /etc/aistudio-studio/deploy.conf
export PATH="$APP_ROOT/tools/node_modules/.bin:$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
exec 9>/run/lock/aistudio-studio-deploy.lock
flock -n 9 || exit 0

git -C "$APP_ROOT/repository" fetch --quiet origin main
commit=$(git -C "$APP_ROOT/repository" rev-parse origin/main)
if [[ -f "$APP_ROOT/deployed-commit" ]] && [[ $(cat "$APP_ROOT/deployed-commit") == "$commit" ]] && [[ ${1:-} != --force ]]; then
  exit 0
fi
if [[ -f "$APP_ROOT/failed-commit" ]] && [[ $(cat "$APP_ROOT/failed-commit") == "$commit" ]] && [[ ${1:-} != --force ]]; then
  exit 0
fi
record_failure() {
  trap - ERR INT TERM
  printf '%s\n' "$commit" > "$APP_ROOT/failed-commit"
  echo "Deployment failed for $commit; inspect logs and retry with --force." >&2
  exit 1
}
trap record_failure ERR INT TERM
release="$APP_ROOT/releases/$commit"
previous=$(readlink -f "$APP_ROOT/current" || true)
if [[ "$previous" == "$release" ]]; then
  echo 'Current release is missing its deployment marker; inspect before rebuilding.' >&2
  exit 1
fi
echo "Building main commit $commit"
# A failed build is reusable only after it has been completely rebuilt.
if [[ -d "$release" ]]; then
  [[ "$release" == "$APP_ROOT/releases/"* && ! -L "$release" ]]
  rm -rf -- "$release"
fi
mkdir -p "$release"
git -C "$APP_ROOT/repository" archive "$commit" | tar -x -C "$release"
chown -R "$APP_USER:$APP_USER" "$release"
runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$APP_ROOT/home" CI=true pnpm --dir "$release" install --frozen-lockfile
runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$APP_ROOT/home" pnpm --dir "$release" build
runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$APP_ROOT/home" npm --prefix "$release/apps/admin" ci --no-audit --no-fund
runuser -u "$APP_USER" -- env PATH="$PATH" HOME="$APP_ROOT/home" npm --prefix "$release/apps/admin" run build
test -s "$release/dist/system/server.js"
test -s "$release/apps/admin/dist/index.html"

backup="$APP_ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)-$commit.sqlite"
backup_ready=false
rollback() {
  trap - ERR INT TERM
  set +e
  restored=true
  systemctl stop aistudio-studio.service || true
  if [[ "$backup_ready" == true ]]; then
    if ! python3 - "$backup" "$DATA_ROOT/system.sqlite" <<'PY'
import os,pathlib,shutil,sys
target=pathlib.Path(sys.argv[2])
pending=target.with_name(target.name+'.restore')
shutil.copyfile(sys.argv[1],pending)
os.chmod(pending,0o600)
os.replace(pending,target)
for suffix in ('-wal','-shm'):
    pathlib.Path(str(target)+suffix).unlink(missing_ok=True)
PY
    then restored=false; fi
    chown "$APP_USER:$APP_USER" "$DATA_ROOT/system.sqlite" || restored=false
  fi
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$APP_ROOT/current.next" && mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current" || restored=false
    if [[ "$restored" == true ]]; then systemctl start aistudio-studio.service || restored=false; fi
  fi
  echo "Deployment failed; previous=$previous rollback_success=$restored" >&2
  record_failure
}
trap rollback ERR INT TERM
# Stop writers before snapshotting SQLite, including its committed WAL contents.
systemctl stop aistudio-studio.service
if [[ -f "$DATA_ROOT/system.sqlite" ]]; then
  python3 - "$DATA_ROOT/system.sqlite" "$backup" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
    source.backup(target)
PY
  backup_ready=true
fi
ln -sfn "$release" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
systemctl start aistudio-studio.service
healthy=false
for attempt in {1..30}; do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$SYSTEM_PORT/health" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="ok"' 2>/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]]
curl --silent --fail --max-time 10 "http://127.0.0.1:$SYSTEM_PORT/admin/" -o /dev/null
curl --silent --fail --max-time 15 "https://$DOMAIN/health" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="ok"'
printf '%s\n' "$commit" > "$APP_ROOT/deployed-commit.next"
mv -f "$APP_ROOT/deployed-commit.next" "$APP_ROOT/deployed-commit"
rm -f "$APP_ROOT/failed-commit"
trap - ERR INT TERM
# The next poll uses the deployment logic from the successful main release.
install -m 0755 "$release/server/deploy/deploy.sh" /usr/local/sbin/aistudio-studio-deploy
echo "DEPLOYED $commit https://$DOMAIN/admin/"
