import net from 'node:net';
import { pathToFileURL } from 'node:url';

export function createIngress({ host = '127.0.0.1', port = 3001, waitMs = 90_000, retryMs = 100, maxConnections = 1024 } = {}) {
  const connections = new Set();
  const server = net.createServer({ allowHalfOpen: true }, client => {
    client.pause();
    connections.add(client);
    let upstream;
    let retry;
    let connected = false;
    const deadline = setTimeout(() => client.destroy(), waitMs);
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(retry);
      upstream?.destroy();
      connections.delete(client);
    };
    client.on('close', cleanup);
    client.on('error', () => client.destroy());
    const connect = () => {
      if (client.destroyed) return;
      upstream = net.createConnection({ host, port, allowHalfOpen: true });
      upstream.once('connect', () => {
        if (client.destroyed) { upstream.destroy(); return; }
        connected = true;
        clearTimeout(deadline);
        client.pipe(upstream).pipe(client);
        client.resume();
      });
      upstream.once('error', error => {
        if (!connected && error.code === 'ECONNREFUSED' && !client.destroyed) {
          retry = setTimeout(connect, retryMs);
        } else client.destroy();
      });
      upstream.once('close', () => { if (connected && !upstream.readableEnded) client.destroy(); });
    };
    connect();
  });
  server.maxConnections = maxConnections;
  return { server, close: async () => {
    for (const client of connections) client.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, close } = createIngress({ port: Number(process.env.SYSTEM_PORT ?? 3001) });
  server.on('error', error => { console.error(error.code ?? 'INGRESS_ERROR'); process.exit(1); });
  server.listen(Number(process.env.SYSTEM_INGRESS_PORT ?? 3002), '127.0.0.1');
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
