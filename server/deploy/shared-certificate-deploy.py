#!/usr/bin/python3
"""Validate and atomically deploy the shared certificate, including Studio."""
import datetime
import fcntl
import json
import os
import pathlib
import re
import subprocess

BASE = pathlib.Path('/www/server/panel/vhost/cert/crypto-compass-web.online-shared')
EXPECTED = {
    'crypto-compass-web.online', 'www.crypto-compass-web.online',
    'ai.crypto-compass-web.online', 'proxy.crypto-compass-web.online',
    'studio.crypto-compass-web.online',
}
# Separate from the issuance/renewal lock: ACME synchronously invokes this hook.
deployment_lock = open('/run/lock/aistudio-shared-certificate-install.lock', 'w')
fcntl.flock(deployment_lock, fcntl.LOCK_EX)


def openssl(*args, data=None):
    return subprocess.run(['/usr/bin/openssl', *args], input=data, capture_output=True, check=True).stdout


def write(path, data, mode):
    pending = path.with_name(path.name + '.pending')
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(pending, mode)
    os.replace(pending, path)


chain = BASE / 'incoming.fullchain'
key = BASE / 'incoming.key'
san = openssl('x509', '-in', str(chain), '-noout', '-ext', 'subjectAltName').decode()
actual = set(re.findall(r'DNS:([^,\s]+)', san))
if actual != EXPECTED:
    raise ValueError('Certificate coverage differs from managed domains')
dates = openssl('x509', '-in', str(chain), '-noout', '-dates').decode()
valid = {
    name: datetime.datetime.strptime(value, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
    for name, value in (line.split('=', 1) for line in dates.splitlines())
}
now = datetime.datetime.now(datetime.timezone.utc)
if not valid['notBefore'] <= now < valid['notAfter']:
    raise ValueError('Certificate outside validity window')
public = openssl('x509', '-in', str(chain), '-pubkey', '-noout')
if openssl('pkey', '-pubin', '-outform', 'DER', data=public) != openssl('pkey', '-in', str(key), '-pubout', '-outform', 'DER'):
    raise ValueError('Certificate key mismatch')
targets = {BASE / 'privkey.pem': (key.read_bytes(), 0o600), BASE / 'fullchain.pem': (chain.read_bytes(), 0o644)}
old = {path: path.read_bytes() if path.exists() else None for path in targets}
try:
    for path, (data, mode) in targets.items():
        write(path, data, mode)
    subprocess.run(['/usr/bin/nginx', '-t'], check=True)
    subprocess.run(['/usr/bin/nginx', '-s', 'reload'], check=True)
except Exception:
    for path, data in old.items():
        if data is not None:
            write(path, data, targets[path][1])
        else:
            path.unlink(missing_ok=True)
    subprocess.run(['/usr/bin/nginx', '-t'], check=False)
    subprocess.run(['/usr/bin/nginx', '-s', 'reload'], check=False)
    raise
print('SHARED_CERTIFICATE_DEPLOYED', json.dumps({'domains': sorted(actual), 'validTo': valid['notAfter'].isoformat()}))
