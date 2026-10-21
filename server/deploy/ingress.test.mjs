import net from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { createIngress } from './ingress.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server, port = 0) {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(() => resolve()));
  return port;
}
test('holds a request through backend downtime and delivers its body once', async () => {
  const port = await unusedPort();
  const ingress = createIngress({ port, retryMs: 5, waitMs: 2000 });
  cleanup.push(ingress.close);
  const front = await listen(ingress.server);
  const client = net.createConnection({ host: '127.0.0.1', port: front });
  client.on('error', () => {});
  cleanup.push(async () => { client.destroy(); });
  const response = new Promise(resolve => client.once('data', data => resolve(data.toString())));
  client.write('POST body must not be duplicated');
  await new Promise(resolve => setTimeout(resolve, 40));
  let received = '';
  const backend = net.createServer(socket => socket.on('data', data => { received += data; socket.end('ok'); }));
  cleanup.push(async () => { await new Promise(resolve => backend.close(() => resolve())); });
  await listen(backend, port);
  expect(await response).toBe('ok');
  expect(received).toBe('POST body must not be duplicated');
});
test('never reconnects or replays after the backend accepted bytes', async () => {
  let attempts = 0;
  const backend = net.createServer(socket => { attempts++; socket.once('data', () => socket.destroy()); });
  const port = await listen(backend);
  cleanup.push(async () => { await new Promise(resolve => backend.close(() => resolve())); });
  const ingress = createIngress({ port, retryMs: 5 });
  cleanup.push(ingress.close);
  const front = await listen(ingress.server);
  const client = net.createConnection({ host: '127.0.0.1', port: front });
  client.on('error', () => {});
  const closed = new Promise(resolve => client.once('close', () => resolve()));
  client.write('only once');
  await closed;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(attempts).toBe(1);
});
test('bounds the wait when the backend does not recover', async () => {
  const ingress = createIngress({ port: await unusedPort(), retryMs: 5, waitMs: 40 });
  cleanup.push(ingress.close);
  const client = net.createConnection({ host: '127.0.0.1', port: await listen(ingress.server) });
  client.on('error', () => {});
  await new Promise(resolve => client.once('close', () => resolve()));
});
