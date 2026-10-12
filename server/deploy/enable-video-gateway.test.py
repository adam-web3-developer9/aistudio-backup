"""Isolated migration checks; no SSH, production files or provider requests."""
import base64
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('enable-video-gateway.py')


class GatewayMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='studio-gateway-fixture-')
        self.root = Path(self.temporary.name).resolve()
        self.config = self.root / 'config'
        self.data = self.root / 'data'
        self.config.mkdir()
        self.data.mkdir()
        (self.config / 'deploy.conf').write_text(
            'DATA_ROOT=' + "'" + str(self.data) + "'\nAPP_USER=fixture\n", encoding='utf-8')
        self.environment = self.config / 'system.env'
        self.proxy_line = 'MIORA_PROXY_URL=http://fixture-user:fixture-password@proxy.example:12345\n'
        self.original = ('SYSTEM_CHANNELS_ENABLED=false\nSYSTEM_AUTH_SECRET=fixture-auth-secret\n'
                         'SYSTEM_SMTP_PASSWORD="fixture smtp # password"\n' + self.proxy_line)
        self.environment.write_text(self.original, encoding='utf-8')

    def tearDown(self):
        self.temporary.cleanup()

    def run_migration(self, *arguments):
        return subprocess.run([sys.executable, str(SCRIPT), '--fixture-root', str(self.root),
                               '--config-directory', str(self.config), *arguments],
                              capture_output=True, text=True, timeout=10)

    def test_generation_preserves_other_settings_and_is_idempotent(self):
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.environment.read_text(encoding='utf-8')
        self.assertIn('SYSTEM_AUTH_SECRET=fixture-auth-secret\n', updated)
        self.assertIn('SYSTEM_SMTP_PASSWORD="fixture smtp # password"\n', updated)
        self.assertIn('SYSTEM_VIDEO_GATEWAY_ENABLED=true\n', updated)
        values = dict(line.split('=', 1) for line in updated.splitlines())
        self.assertGreaterEqual(len(values['API_KEY']), 32)
        self.assertEqual(len(base64.b64decode(values['CHANNEL_CREDENTIAL_KEY'])), 32)
        self.assertNotIn(values['API_KEY'], result.stdout + result.stderr)
        self.assertIn(self.proxy_line, updated)
        self.assertNotIn('fixture-password', result.stdout + result.stderr)
        backups = list(self.config.glob('system.env.before-video-gateway-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding='utf-8'), self.original)
        self.assertTrue((self.data / 'gateway' / 'miora-imports').is_dir())
        self.assertTrue((self.data / 'gateway' / 'miora-accounts.txt').is_file())
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), updated)
        self.assertEqual(len(list(self.config.glob('system.env.before-video-gateway-*'))), 1)
        self.assertEqual(self.run_migration('--check').returncode, 0)
        self.assertEqual(self.run_migration('--maintain').returncode, 0)

    def test_short_api_key_is_rejected_without_mutation(self):
        original = self.original + 'API_KEY=existing-short-key\n'
        self.environment.write_text(original, encoding='utf-8')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('at least 32', result.stderr)
        self.assertNotIn('existing-short-key', result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), original)
        self.assertFalse((self.data / 'gateway').exists())

    def test_invalid_api_keys_are_rejected_without_mutation(self):
        for key in ('a' * 31 + ' ', 'a' * 32 + '\u4e2d', 'a' * 4097):
            with self.subTest(length=len(key)):
                original = self.original + 'API_KEY="' + key + '"\n'
                self.environment.write_text(original, encoding='utf-8')
                result = self.run_migration()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.environment.read_text(encoding='utf-8'), original)
                self.assertNotIn(key, result.stderr)

    def test_missing_vault_key_with_existing_accounts_fails_closed(self):
        with closing(sqlite3.connect(self.data / 'system.sqlite')) as database:
            database.execute('CREATE TABLE managed_channel_accounts(id TEXT)')
            database.execute("INSERT INTO managed_channel_accounts VALUES('fixture')")
            database.commit()
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('original vault key', result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), self.original)

    def test_existing_keys_are_retained_exactly(self):
        vault_key = base64.b64encode(bytes(range(32))).decode()
        key_line = 'API_KEY="fixture-key-012345678901234567890123456789"\n'
        vault_line = "CHANNEL_CREDENTIAL_KEY='" + vault_key + "'\n"
        original = self.original + key_line + vault_line
        self.environment.write_text(original, encoding='utf-8')
        result = self.run_migration()
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.environment.read_text(encoding='utf-8')
        self.assertIn(key_line, updated)
        self.assertIn(vault_line, updated)
        self.assertNotIn(vault_key, result.stdout + result.stderr)

    def test_maintenance_does_not_enable_and_fixture_cannot_escape(self):
        result = self.run_migration('--maintain')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), self.original)
        self.assertFalse((self.data / 'gateway').exists())
        (self.config / 'deploy.conf').write_text("DATA_ROOT='" + str(self.root.parent) + "'\n", encoding='utf-8')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inside fixture root', result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), self.original)

    def test_active_worker_paths_are_not_silently_replaced(self):
        original = self.original.replace('SYSTEM_CHANNELS_ENABLED=false', 'SYSTEM_CHANNELS_ENABLED=true')
        self.environment.write_text(original, encoding='utf-8')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('recorded jobs/assets', result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), original)

    def proxy_file(self, content):
        source = self.config / 'proxy.env'
        source.write_text(content, encoding='utf-8')
        source.chmod(0o600)
        return source

    def test_missing_proxy_rejects_without_mutation(self):
        original = self.original.replace(self.proxy_line, '')
        self.environment.write_text(original, encoding='utf-8')
        result = self.run_migration()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires explicit MIORA_PROXY_URL', result.stderr)
        self.assertEqual(self.environment.read_text(encoding='utf-8'), original)
        self.assertFalse((self.data / 'gateway').exists())

    def test_private_proxy_file_is_imported_without_exposing_credentials(self):
        original = self.original.replace(self.proxy_line, '')
        self.environment.write_text(original, encoding='utf-8')
        source = self.proxy_file(self.proxy_line + 'MIORA_PROXY_ADDRESS=203.0.113.10\n')
        result = self.run_migration('--proxy-env-file', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        updated = self.environment.read_text(encoding='utf-8')
        self.assertIn(self.proxy_line, updated)
        self.assertIn('MIORA_PROXY_ADDRESS=203.0.113.10\n', updated)
        self.assertNotIn('fixture-password', result.stdout + result.stderr)
        self.assertEqual(self.run_migration('--maintain').returncode, 0)

    def test_proxy_file_conflicts_and_unrelated_keys_preserve_configuration(self):
        for content in ('MIORA_PROXY_URL=http://other:secret@other.example:8080\n',
                        self.proxy_line + 'SYSTEM_AUTH_SECRET=must-not-overwrite\n'):
            with self.subTest(kind='conflict' if 'other.example' in content else 'unrelated'):
                source = self.proxy_file(content)
                result = self.run_migration('--proxy-env-file', str(source))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.environment.read_text(encoding='utf-8'), self.original)
                self.assertNotIn('other:secret', result.stdout + result.stderr)

    def test_proxy_validation_and_loopback_requires_explicit_new_choice(self):
        original = self.original.replace(self.proxy_line, '')
        for url in ('socks5://proxy.example:1080', 'http://proxy.example:99999',
                    'http://proxy.example:8080?secret=not-allowed', 'http://proxy.example/#fragment',
                    'http://proxy.example:8080/path', 'http://127.0.0.1:7897'):
            with self.subTest(kind='proxy-validation'):
                self.environment.write_text(original, encoding='utf-8')
                source = self.proxy_file('MIORA_PROXY_URL=' + url + '\n')
                result = self.run_migration('--proxy-env-file', str(source))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.environment.read_text(encoding='utf-8'), original)
                self.assertNotIn(url, result.stdout + result.stderr)
        result = self.run_migration('--proxy-env-file', str(source), '--allow-loopback-proxy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_migration('--check').returncode, 0)


if __name__ == '__main__':
    unittest.main()
