import { rm } from 'node:fs/promises';

process.env.HOST = '127.0.0.1';
process.env.PORT = '3199';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3199';
process.env.API_KEY = 'smoke-test-key';
process.env.BROWSER_POOL_SIZE = '2';
process.env.BROWSER_HEADLESS = 'true';
process.env.PLAYWRIGHT_BROWSERS_PATH = './.playwright-browsers';
process.env.DATA_DIR = './data-smoke';

const { buildApp } = await import('../dist/app.js');
const app = await buildApp();

try {
  await app.listen({ host: '127.0.0.1', port: 3199 });

  const form = new FormData();
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  form.append('file', new Blob([onePixelPng], { type: 'image/png' }), 'pixel.png');

  const uploadResponse = await fetch('http://127.0.0.1:3199/v1/assets', {
    method: 'POST',
    headers: { 'x-api-key': 'smoke-test-key' },
    body: form
  });
  if (!uploadResponse.ok) throw new Error(`Upload failed: ${await uploadResponse.text()}`);
  const asset = await uploadResponse.json();

  const createdJobs = await Promise.all(
    ['first', 'second', 'third'].map(async (text) => {
      const response = await fetch('http://127.0.0.1:3199/v1/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'smoke-test-key'
        },
        body: JSON.stringify({ adapterId: 'demo-v1', text, assetId: asset.id })
      });
      if (!response.ok) throw new Error(`Create job failed: ${await response.text()}`);
      return response.json();
    })
  );

  const deadline = Date.now() + 30_000;
  const results = [];
  for (const created of createdJobs) {
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:3199/v1/jobs/${created.jobId}`, {
        headers: { 'x-api-key': 'smoke-test-key' }
      });
      const job = await response.json();
      if (job.status === 'succeeded') {
        results.push(job);
        break;
      }
      if (job.status === 'failed') throw new Error(JSON.stringify(job.error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (results.length !== 3) throw new Error('Timed out waiting for all smoke jobs');
  const health = await fetch('http://127.0.0.1:3199/health').then((response) => response.json());
  console.log(JSON.stringify({ health, results: results.map((job) => job.result) }, null, 2));
} finally {
  await app.close();
  await rm('./data-smoke', { recursive: true, force: true });
}
