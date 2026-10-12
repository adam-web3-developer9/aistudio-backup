#!/usr/bin/env python3
"""Explicitly enable the existing Studio worker's Miora compatibility gateway."""
import argparse
import base64
from contextlib import closing
from datetime import datetime, timezone
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shlex
import sqlite3
import sys
from urllib.parse import urlsplit


class ConfigurationError(Exception):
    pass


def read_assignments(file, shell=False):
    content = file.read_text(encoding='utf-8')
    values = {}
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if '=' not in stripped:
            raise ConfigurationError(f'Unsupported configuration line in {file.name}')
        key, raw = stripped.split('=', 1)
        if not key.isidentifier() or key in values:
            raise ConfigurationError(f'Invalid or duplicate configuration key in {file.name}')
        if shell:
            try:
                parts = shlex.split(raw, comments=True)
            except ValueError:
                raise ConfigurationError(f'Invalid configuration quoting in {file.name}') from None
            if len(parts) > 1:
                raise ConfigurationError(f'Unquoted whitespace in {file.name}')
            values[key] = parts[0] if parts else ''
        else:
            value = raw.strip()
            if value.startswith(('"', "'")):
                quote = value[0]
                if len(value) < 2 or value[-1] != value[0]:
                    raise ConfigurationError(f'Invalid configuration quoting in {file.name}')
                value = value[1:-1]
                if quote == '"':
                    value = re.sub(r'\\([\\"])', r'\1', value)
            values[key] = value
    return content, values


def safe_path(value, name, fixture_root=None):
    candidate = Path(value)
    if not candidate.is_absolute() or candidate == Path(candidate.anchor):
        raise ConfigurationError(f'{name} must be an absolute non-root path')
    resolved = candidate.resolve()
    if candidate != resolved:
        raise ConfigurationError(f'{name} must not contain symlinks or parent traversal')
    if fixture_root is not None and not resolved.is_relative_to(fixture_root):
        raise ConfigurationError(f'{name} must stay inside fixture root')
    return resolved


def database_has_accounts(database):
    if not database.exists():
        return False
    if database.is_symlink():
        raise ConfigurationError('Database must not be a symlink')
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_channel_accounts'").fetchone()
            return bool(exists and connection.execute('SELECT 1 FROM managed_channel_accounts LIMIT 1').fetchone())
    except sqlite3.Error:
        raise ConfigurationError('Cannot inspect existing channel vault; configuration was preserved') from None


def validate_keys(values, database, generate):
    api_key = values.get('API_KEY', '')
    if api_key and not re.fullmatch(r'[!-~]{32,4096}', api_key):
        raise ConfigurationError('Existing API_KEY must contain at least 32 and at most 4096 visible ASCII characters without spaces; retained unchanged. Set a strong key explicitly before retrying.')
    if not api_key:
        if not generate:
            raise ConfigurationError('Enabled gateway requires API_KEY of 32..4096 visible ASCII characters without spaces')
        api_key = secrets.token_urlsafe(48)
    vault_key = values.get('CHANNEL_CREDENTIAL_KEY', '')
    if vault_key:
        try:
            decoded = base64.b64decode(vault_key, validate=True)
            if len(decoded) != 32 or base64.b64encode(decoded).decode() != vault_key:
                raise ValueError()
        except (ValueError, TypeError):
            raise ConfigurationError('Existing CHANNEL_CREDENTIAL_KEY is invalid; retained unchanged') from None
    else:
        if database_has_accounts(database):
            raise ConfigurationError('Managed accounts already exist but CHANNEL_CREDENTIAL_KEY is missing; restore the original vault key before retrying')
        if not generate:
            raise ConfigurationError('Enabled gateway requires CHANNEL_CREDENTIAL_KEY')
        vault_key = base64.b64encode(secrets.token_bytes(32)).decode()
    return api_key, vault_key


PROXY_KEYS = {'MIORA_PROXY_URL', 'MIORA_PROXY_ADDRESS', 'MIORA_LOCAL_PROXY_URL'}


def validate_proxy_url(value, allow_loopback):
    try:
        if not value or not re.fullmatch(r'[!-~]+', value):
            raise ValueError()
        url = urlsplit(value)
        host = url.hostname
        if url.scheme not in ('http', 'https') or not host or url.path not in ('', '/') or url.query or url.fragment:
            raise ValueError()
        if url.netloc.endswith(':') or url.port is not None and not 1 <= url.port <= 65535:
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
            loopback = address.is_loopback
        except ValueError:
            if len(host) > 253 or not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.rstrip('.').split('.')):
                raise ValueError()
            loopback = host.lower().rstrip('.') == 'localhost' or host.lower().rstrip('.').endswith('.localhost')
    except ValueError:
        raise ConfigurationError('MIORA_PROXY_URL must be a valid HTTP(S) proxy URL with a host and valid port, without query, fragment, path or whitespace; proxy details were not displayed') from None
    if loopback and not allow_loopback:
        raise ConfigurationError('A loopback proxy requires explicit --allow-loopback-proxy for a server-managed local proxy')


def proxy_configuration(values, file, fixture_root, allow_loopback):
    updates = {}
    if file:
        source = safe_path(file, 'proxy configuration file', fixture_root)
        if not source.is_file() or os.name != 'nt' and source.stat().st_mode & 0o077:
            raise ConfigurationError('Proxy configuration file must be a private regular file with mode 0600 or stricter')
        _, supplied = read_assignments(source)
        if set(supplied) - PROXY_KEYS:
            raise ConfigurationError('Proxy configuration file may contain only MIORA_PROXY_URL, MIORA_PROXY_ADDRESS and MIORA_LOCAL_PROXY_URL')
        for key, value in supplied.items():
            existing = values.get(key, '')
            if existing and value and existing != value:
                raise ConfigurationError(f'Proxy configuration conflicts with existing {key}; existing configuration was preserved')
            if not existing and value:
                updates[key] = value
    proxy = values.get('MIORA_PROXY_URL') or updates.get('MIORA_PROXY_URL')
    if not proxy:
        raise ConfigurationError('Online Miora gateway requires explicit MIORA_PROXY_URL; supply a private --proxy-env-file or configure the server file. Windows auto/direct routing is insufficient.')
    # Existing server configuration is an explicit operator choice, including a local proxy.
    validate_proxy_url(proxy, allow_loopback or bool(values.get('MIORA_PROXY_URL')))
    address = values.get('MIORA_PROXY_ADDRESS') or updates.get('MIORA_PROXY_ADDRESS')
    if address:
        try:
            ipaddress.ip_address(address)
        except ValueError:
            raise ConfigurationError('MIORA_PROXY_ADDRESS must be a valid IP address; existing configuration was preserved') from None
    return updates


def gateway_paths(data_root):
    directory = data_root / 'gateway'
    return {
        'DATA_DIR': str(directory),
        'HAILUO_TOKEN_FILE': str(directory / 'tokens.txt'),
        'DREAMMAKER_ACCOUNT_FILE': str(directory / 'dreammaker-accounts.txt'),
        'HIGGSFIELD_ACCOUNT_FILE': str(directory / 'higgsfield-accounts.txt'),
        'MIORA_ACCOUNT_FILE': str(directory / 'miora-accounts.txt'),
        'MIORA_IMPORT_DIR': str(directory / 'miora-imports'),
    }


def prepare_data(paths, owner, fixture_root):
    for key in ('DATA_DIR', 'MIORA_IMPORT_DIR'):
        directory = safe_path(paths[key], key, fixture_root)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        if owner is not None:
            os.chown(directory, owner.pw_uid, owner.pw_gid)
    for key in ('HAILUO_TOKEN_FILE', 'DREAMMAKER_ACCOUNT_FILE', 'HIGGSFIELD_ACCOUNT_FILE', 'MIORA_ACCOUNT_FILE'):
        file = safe_path(paths[key], key, fixture_root)
        if not file.exists():
            descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
        if not file.is_file():
            raise ConfigurationError(f'{key} must be a regular file')
        os.chmod(file, 0o600)
        if owner is not None:
            os.chown(file, owner.pw_uid, owner.pw_gid)


def rendered_environment(content, updates):
    remaining = dict(updates)
    lines = []
    for line in content.splitlines():
        key = line.strip().split('=', 1)[0]
        if key in remaining:
            line = key + '=' + environment_value(remaining.pop(key))
        lines.append(line)
    lines.extend(key + '=' + environment_value(value) for key, value in remaining.items())
    return '\n'.join(lines) + '\n'


def environment_value(value):
    if re.fullmatch(r'[A-Za-z0-9_@%+=:,./-]+', value):
        return value
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def save_environment(file, original, updated):
    if original == updated:
        return None
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = file.with_name(file.name + '.before-video-gateway-' + stamp)
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    pending = file.with_name(file.name + '.video-gateway-' + secrets.token_hex(8))
    try:
        descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        if file.read_text(encoding='utf-8') != original:
            raise ConfigurationError('system.env changed during migration; configuration was preserved')
        os.replace(pending, file)
    finally:
        pending.unlink(missing_ok=True)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-directory', default='/etc/aistudio-studio')
    parser.add_argument('--fixture-root', help='Isolated local fixture root; all config/data paths must stay inside it; skips root and service ownership checks')
    parser.add_argument('--proxy-env-file', help='Private server-only file containing proxy settings; never put proxy credentials on the command line')
    parser.add_argument('--allow-loopback-proxy', action='store_true', help='Explicitly allow a server-managed loopback proxy supplied in --proxy-env-file')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Read-only validation; does not enable gateway')
    mode.add_argument('--maintain', action='store_true', help='Validate enabled gateway and prepare its persistent directories; never enables it')
    args = parser.parse_args()
    fixture_root = safe_path(args.fixture_root, 'fixture root') if args.fixture_root else None
    if fixture_root is None and (not hasattr(os, 'geteuid') or os.geteuid() != 0):
        raise ConfigurationError('Run as root; isolated local validation may use --fixture-root')
    directory = safe_path(args.config_directory, 'configuration directory', fixture_root)
    for name in ('deploy.conf', 'system.env'):
        if (directory / name).is_symlink():
            raise ConfigurationError(f'{name} must not be a symlink')
    _, deployment = read_assignments(directory / 'deploy.conf', shell=True)
    environment = directory / 'system.env'
    content, values = read_assignments(environment)
    if (args.check or args.maintain) and values.get('SYSTEM_VIDEO_GATEWAY_ENABLED') != 'true':
        print('Video gateway remains disabled; no configuration changed.')
        return
    data_root = safe_path(deployment.get('DATA_ROOT', ''), 'DATA_ROOT', fixture_root)
    database = safe_path(values.get('SYSTEM_DATABASE_PATH', str(data_root / 'system.sqlite')), 'SYSTEM_DATABASE_PATH', fixture_root)
    owner = None
    if fixture_root is None:
        import pwd
        try:
            owner = pwd.getpwnam(deployment.get('APP_USER', ''))
        except KeyError:
            raise ConfigurationError('APP_USER is not an existing service account') from None
    api_key, vault_key = validate_keys(values, database, not (args.check or args.maintain))
    proxy_updates = proxy_configuration(values, args.proxy_env_file, fixture_root, args.allow_loopback_proxy)
    if (args.check or args.maintain) and proxy_updates:
        raise ConfigurationError('Read-only validation/maintenance cannot import proxy settings; run the explicit migration first')
    paths = gateway_paths(data_root)
    if args.check or args.maintain:
        if values.get('SYSTEM_CHANNELS_ENABLED') != 'true':
            raise ConfigurationError('Enabled video gateway requires SYSTEM_CHANNELS_ENABLED=true')
        if any(values.get(key) != value for key, value in paths.items()):
            raise ConfigurationError('Gateway persistence paths differ from DATA_ROOT/gateway; run the explicit migration first')
        if args.maintain:
            prepare_data(paths, owner, fixture_root)
        print('Video gateway configuration validated; credentials were not displayed.')
        return
    # Do not move an existing worker to another data directory: preserve its recorded work.
    if values.get('SYSTEM_CHANNELS_ENABLED') == 'true' and any(values.get(key) != value for key, value in paths.items()):
        raise ConfigurationError('An active worker uses another DATA_DIR; migrate its recorded jobs/assets explicitly before enabling this gateway')
    updates = {**paths, **proxy_updates, 'SYSTEM_CHANNELS_ENABLED': 'true', 'SYSTEM_VIDEO_GATEWAY_ENABLED': 'true'}
    if not values.get('API_KEY'):
        updates['API_KEY'] = api_key
    if not values.get('CHANNEL_CREDENTIAL_KEY'):
        updates['CHANNEL_CREDENTIAL_KEY'] = vault_key
    updated = rendered_environment(content, updates)
    prepare_data(paths, owner, fixture_root)
    backup = save_environment(environment, content, updated)
    if backup:
        print(f'Configuration backup: {backup}')
    print('Miora gateway configured on the existing Studio service; restart aistudio-studio.service to activate. API_KEY remains only in system.env.')


if __name__ == '__main__':
    try:
        main()
    except (ConfigurationError, OSError) as error:
        # Configuration values and credentials must never appear in diagnostics.
        message = str(error) if isinstance(error, ConfigurationError) else 'Cannot access gateway configuration or persistent storage'
        print(message, file=sys.stderr)
        sys.exit(1)
