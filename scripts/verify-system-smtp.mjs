import nodemailer from 'nodemailer';

// Authenticate only. No test message, recipient or verification URL is sent.
const env = process.env;
if (!env.SYSTEM_SMTP_HOST || !env.SYSTEM_SMTP_FROM || !env.SYSTEM_SMTP_USER || !env.SYSTEM_SMTP_PASSWORD) {
  console.error('SMTP_CONFIGURATION_INCOMPLETE: configure the server-only SMTP authorization code.');
  process.exit(2);
}
const transport = nodemailer.createTransport({
  host: env.SYSTEM_SMTP_HOST,
  port: Number(env.SYSTEM_SMTP_PORT ?? 465),
  secure: env.SYSTEM_SMTP_SECURE === 'true',
  auth: { user: env.SYSTEM_SMTP_USER, pass: env.SYSTEM_SMTP_PASSWORD },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});
try {
  await transport.verify();
  console.log('SMTP_AUTHENTICATION_OK');
} catch (error) {
  // SMTP error messages can contain account or server details. Emit only a safe category.
  const category = ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET'].includes(error?.code) ? error.code : 'SMTP_FAILED';
  console.error(`SMTP_AUTHENTICATION_FAILED: ${category}`);
  process.exitCode = 1;
} finally {
  transport.close();
}
