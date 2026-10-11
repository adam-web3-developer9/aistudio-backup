import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AccountSnapshot } from './account-pool.js';

export class AccountBalanceReporter {
  readonly filePath: string;
  private pending?: AccountSnapshot[];
  private writing?: Promise<void>;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'TOKEN_BALANCES.md');
  }

  async update(accounts: AccountSnapshot[]): Promise<void> {
    this.pending = accounts;
    if (!this.writing) this.writing = this.flush();
    await this.writing;
  }

  private async flush(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      while (this.pending) {
        const accounts = this.pending;
        this.pending = undefined;
        await writeFile(this.filePath, renderAccountBalances(accounts), 'utf8');
      }
    } finally {
      this.writing = undefined;
    }
  }
}

export function renderAccountBalances(accounts: AccountSnapshot[], now = new Date()): string {
  const rows = accounts
    .filter((account) => account.tokenMasked)
    .sort((a, b) =>
      (b.credits ?? Number.NEGATIVE_INFINITY) - (a.credits ?? Number.NEGATIVE_INFINITY)
      || a.sessionId.localeCompare(b.sessionId));

  const lines = [
    '# 海螺 Token 积分余额',
    '',
    `更新时间：${now.toISOString()}`,
    '',
    '| 排名 | Session | Token（脱敏） | 账号 | 积分余额 | 状态 | 余额读取时间 |',
    '|---:|---|---|---|---:|---|---|'
  ];

  rows.forEach((account, index) => {
    lines.push([
      `| ${index + 1}`,
      md(account.sessionId),
      md(account.tokenMasked ?? ''),
      md(account.account?.name ?? account.account?.userId ?? '-'),
      account.credits === undefined ? '-' : String(account.credits),
      md(accountStatus(account)),
      md(account.creditsCheckedAt ?? '-') + ' |'
    ].join(' | '));
  });

  if (!rows.length) lines.push('| - | - | - | - | - | 暂无 Token | - |');
  lines.push('', '> 自动生成，请勿手工编辑。任务完成后会重新查询对应账号余额并更新本表。', '');
  return lines.join('\n');
}

function accountStatus(account: AccountSnapshot): string {
  if (account.lastError) return `读取失败：${account.lastError}`;
  if (account.exhausted) return '已耗尽';
  if (account.busy) return '任务中';
  if (account.depleted) return '当前任务积分不足';
  return '空闲';
}

function md(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
