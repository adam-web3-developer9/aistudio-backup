#!/usr/bin/env node
/**
 * Import every miora.design site-state export in the import directory
 * (MIORA_IMPORT_DIR, default ./miora-imports) into the account file
 * (MIORA_ACCOUNT_FILE, default ./miora-accounts.txt).
 *
 * The running gateway does the same on its own whenever the directory changes;
 * this is the manual trigger. Accounts are deduplicated by user, and a known
 * account is only replaced by a newer token — see src/jobs/miora-import.ts.
 *
 *   npm run miora:import
 */
import { config } from '../src/config.js';
import { hasUsableScopes, describeMioraToken } from '../src/adapters/miora-api.js';
import { importMioraExports } from '../src/jobs/miora-import.js';
import { mkdir } from 'node:fs/promises';

const STATUS = {
  added: '新增',
  updated: '更新',
  unchanged: '无变化',
  stale: '跳过（文件里已有更新的令牌）'
};

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log('用法: npm run miora:import');
    console.log(`导入目录 ${config.mioraImportDir} 下所有 *.json 到 ${config.mioraAccountFile}`);
    return;
  }
  await mkdir(config.mioraImportDir, { recursive: true });
  const report = await importMioraExports(config.mioraImportDir,config.mioraAccountFile);

  if (!report.results.length && !report.skipped.length) {
    console.log(`导入目录是空的：把 miora.design 的导出 JSON 放进 ${config.mioraImportDir}`);
    return;
  }
  for (const result of report.results) {
    const { tokens } = result;
    console.log(`${STATUS[result.status]}  ${result.sessionId}  ${result.email ?? '(未知邮箱)'}`);
    console.log(`  来源:         ${result.source}`);
    if (result.status === 'stale' || result.status === 'unchanged') continue;
    console.log(`  authToken到期: ${describeMioraToken(tokens.authToken)?.expiresAt ?? '(未知)'}`);
    console.log(`  scopes:       ${hasUsableScopes(tokens.authToken) ? '["*"]' : '空（不影响生成）'}`);
    console.log(`  refreshToken: ${tokens.refreshToken ? '有（可自动续期）' : '无 ⚠ authToken 到期后需重新导出'}`);
    console.log(`  cookie:       ${tokens.cookie ? `${tokens.cookie.split('; ').length} 个（含 T-Sec 风控）` : '无 ⚠ 可能被风控 401'}`);
  }
  for (const skipped of report.skipped) {
    console.log(`忽略  ${skipped.file}：${skipped.reason}`);
  }
  console.log(report.written ? `已写入 ${config.mioraAccountFile}` : '账号文件无需改动');
}

main().catch((error) => {
  console.error(`导入失败: ${error.message}`);
  process.exitCode = 1;
});
