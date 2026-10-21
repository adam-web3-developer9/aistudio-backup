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
function trackServer(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server;
}
function readResponse(client) {
  const chunks = [];
  client.on('data', chunk => chunks.push(chunk));
  client.on('error', () => {});
  cleanup.push(async () => { client.destroy(); });
  return new Promise(resolve => client.once('close', () => resolve(Buffer.concat(chunks))));
}
test('flushes the complete response through downstream backpressure before closing', async () => {
  const payload = Buffer.alloc(256 * 1024 + 17, 65);
  const backend = trackServer(net.createServer(socket => socket.once('data', () => socket.end(payload))));
  const ingress = createIngress({ port: await listen(backend) });
  cleanup.push(ingress.close);
  ingress.server.on('connection', socket => {
    const write = socket._write;
    socket._write = function (chunk, encoding, done) {
      setTimeout(() => {
        if (socket.destroyed) done();
        else write.call(socket, chunk, encoding, done);
      }, 20);
    };
  });
  const client = net.createConnection({ host: '127.0.0.1', port: await listen(ingress.server) });
  const response = readResponse(client);
  client.on('end', () => client.end());
  client.write('request');
  const received = await response;
  expect(received.length).toBe(payload.length);
  expect(received.equals(payload)).toBe(true);
});
test('preserves the response after the client half-closes its request', async () => {
  const payload = Buffer.alloc(128 * 1024 + 23, 66);
  let request = '';
  const backend = trackServer(net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => { request += chunk; });
    socket.on('end', () => setTimeout(() => { if (!socket.destroyed) socket.end(payload); }, 20));
  }));
  const ingress = createIngress({ port: await listen(backend) });
  cleanup.push(ingress.close);
  const client = net.createConnection({ host: '127.0.0.1', port: await listen(ingress.server), allowHalfOpen: true });
  const response = readResponse(client);
  client.end('complete-request');
  const received = await response;
  expect(request).toBe('complete-request');
  expect(received.length).toBe(payload.length);
  expect(received.equals(payload)).toBe(true);
});
test('keeps forwarding the request after the upstream half-closes its response', async () => {
  let received = '';
  let finishRequest;
  const request = new Promise(resolve => { finishRequest = resolve; });
  const backend = trackServer(net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => { received += chunk; });
    socket.on('end', () => finishRequest(received));
    socket.end('response-first');
  }));
  const ingress = createIngress({ port: await listen(backend) });
  cleanup.push(ingress.close);
  const client = net.createConnection({ host: '127.0.0.1', port: await listen(ingress.server), allowHalfOpen: true });
  const response = readResponse(client);
  client.on('end', () => client.end('request-after-response-fin'));
  expect((await response).toString()).toBe('response-first');
  expect(await request).toBe('request-after-response-fin');
});
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
test('never reconnects after an established upstream resets before any request bytes', async () => {
  let attempts = 0;
  const backend = trackServer(net.createServer(socket => {
    attempts++;
    socket.on('error', () => {});
    socket.resetAndDestroy();
  }));
  const ingress = createIngress({ port: await listen(backend), retryMs: 5 });
  cleanup.push(ingress.close);
  const client = net.createConnection({ host: '127.0.0.1', port: await listen(ingress.server) });
  const response = readResponse(client);
  expect((await response).length).toBe(0);
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
