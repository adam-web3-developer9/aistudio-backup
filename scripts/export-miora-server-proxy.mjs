import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { config } from '../dist/config.js';
import { assertVideoGatewayProxyConfiguration } from '../dist/system-channels/video-gateway.js';

// The default destination is ignored by Git; never print proxy credentials.
assertVideoGatewayProxyConfiguration(true, config.mioraProxyUrl);
if (config.mioraProxyAddress && !isIP(config.mioraProxyAddress)) throw new Error('Miora proxy address is invalid');
const destination = path.resolve('tmp/miora-server-proxy.env');
await mkdir(path.dirname(destination), { recursive: true });
const values = { MIORA_PROXY_URL: config.mioraProxyUrl,
  ...(config.mioraProxyAddress ? { MIORA_PROXY_ADDRESS: config.mioraProxyAddress } : {}) };
const content = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
await writeFile(destination, content, { flag: 'wx', mode: 0o600 });
console.log(`Private server proxy configuration saved to ${destination}; credentials were not displayed.`);
