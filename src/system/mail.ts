import nodemailer from 'nodemailer';

export interface VerificationMail { to: string; name: string; url: string }
export interface SystemMailer {
  sendVerification(message: VerificationMail): Promise<void>;
  sendPasswordReset(message: VerificationMail): Promise<void>;
  close?(): void;
}

/** Test-only outbox: no endpoint exposes messages or verification links. */
export class MemorySystemMailer implements SystemMailer {
  readonly messages: VerificationMail[] = [];
  readonly passwordResets: VerificationMail[] = [];
  async sendVerification(message: VerificationMail): Promise<void> { this.messages.push({ ...message }); }
  async sendPasswordReset(message: VerificationMail): Promise<void> { this.passwordResets.push({ ...message }); }
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
}

export function createSmtpMailer(options: SmtpOptions): SystemMailer {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: !options.secure,
    auth: options.user ? { user: options.user, pass: options.password } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async sendVerification(message) {
      await transporter.sendMail({
        from: options.from,
        to: message.to,
        subject: 'Verify your account email',
        text: `Verify your email by opening this link:\n${message.url}\n\nIf you did not register, ignore this message.`,
      });
    },
    async sendPasswordReset(message) {
      await transporter.sendMail({
        from: options.from, to: message.to, subject: 'Reset your account password',
        text: `Reset your password by opening this link:\n${message.url}\n\nIf you did not request this, ignore this message.`,
      });
    },
    close: () => transporter.close(),
  };
}
