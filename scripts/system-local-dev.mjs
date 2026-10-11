import { buildLocalAcceptanceApp } from '../src/system/local-dev.ts';

let app;
try {
  const local = await buildLocalAcceptanceApp({
    enabled: process.env.SYSTEM_LOCAL_TEST,
    directory: process.env.SYSTEM_LOCAL_TEST_DIRECTORY,
    port: process.env.SYSTEM_LOCAL_TEST_PORT ? Number(process.env.SYSTEM_LOCAL_TEST_PORT) : undefined,
    adminDirectory: process.env.SYSTEM_LOCAL_TEST_ADMIN_DIRECTORY,
  });
  app = local.app;
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  await app.listen({ host: '127.0.0.1', port: local.port });
  // Intentionally omit auth secrets, mailbox marker and verification/reset URLs.
  console.log(`Local acceptance: ${local.baseUrl}/admin/`);
  console.log(`Test directory: ${local.directory}`);
  console.log(`Private mailbox access file: ${local.markerPath}`);
  console.log('Channels are off; no users or activation eligibility are pre-created. Ctrl+C stops the service.');
} catch (error) {
  if (app) await app.close();
  console.error(error instanceof Error ? error.message : 'Local acceptance could not start');
  process.exitCode = 1;
}
