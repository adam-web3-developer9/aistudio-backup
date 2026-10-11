import { spawn } from 'node:child_process';
import path from 'node:path';

const browserPath = path.resolve('.playwright-browsers');
const cliPath = path.resolve('node_modules/playwright/cli.js');

const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserPath,
    PLAYWRIGHT_DOWNLOAD_HOST:
      process.env.PLAYWRIGHT_DOWNLOAD_HOST ?? 'https://npmmirror.com/mirrors/playwright'
  },
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
