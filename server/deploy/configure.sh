#!/usr/bin/env bash
# Initialize server-only configuration. Existing secrets/config are retained.
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
[[ ${1:-} =~ ^[a-zA-Z0-9._%+-]+@qq\.com$ ]] || { echo 'Usage: bash configure.sh sender@qq.com' >&2; exit 1; }
directory=$(cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0700 /etc/aistudio-studio
[[ -f /etc/aistudio-studio/deploy.conf ]] || install -m 0600 "$directory/deploy.conf.example" /etc/aistudio-studio/deploy.conf
python3 - "$directory/system.env.example" "$1" <<'PY'
import os,pathlib,secrets,sys
target=pathlib.Path('/etc/aistudio-studio/system.env')
if not target.exists():
    content=pathlib.Path(sys.argv[1]).read_text().replace('REPLACE_WITH_SERVER_GENERATED_RANDOM_SECRET',secrets.token_urlsafe(48)).replace('REPLACE_WITH_QQ_EMAIL',sys.argv[2])
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'w') as stream:
        stream.write(content)
os.chmod(target,0o600)
print('Server configuration ready; QQ SMTP authorization code must be set in system.env.')
PY
