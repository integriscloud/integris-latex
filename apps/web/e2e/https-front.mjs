// HTTPS front of the end-to-end tests (playwright.config.ts). It plays the part of Nginx for
// the public URLs of the app and the files domain, which latex-dev cannot reach through its own
// public IP; and Chrome 120 (project "chromium-120") drops Secure cookies over plain HTTP, so
// it needs the app over HTTPS. The browsers use it as their HTTP proxy: it answers CONNECT only
// for these two hosts, ends TLS with a throwaway self-signed certificate (the projects ignore
// certificate errors) and forwards to the local ports.
//   node e2e/https-front.mjs <app URL> <files URL> <proxy port>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [appUrl, filesUrl, proxyPort] = process.argv.slice(2);
const appHost = new URL(appUrl).hostname;
const filesHost = new URL(filesUrl).hostname;

// Fixed local ports of latex-dev (CLAUDE.md, "Dev server"); files: packages/shared PORTS.files.
const WEB = 3000;
const COLLAB = 1234;
const FILES = 4100;

const certificates = mkdtempSync(join(tmpdir(), 'integris-e2e-front-'));
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=integris-e2e',
    '-addext',
    `subjectAltName=DNS:${appHost},DNS:${filesHost}`,
    '-keyout',
    join(certificates, 'key.pem'),
    '-out',
    join(certificates, 'cert.pem'),
  ],
  { stdio: 'ignore' },
);
const tls = {
  key: readFileSync(join(certificates, 'key.pem')),
  cert: readFileSync(join(certificates, 'cert.pem')),
};
rmSync(certificates, { recursive: true });

/** Local port of a request, routed as Nginx does on latex-dev. */
function portOf(host, path) {
  if (host === filesHost) return FILES;
  return path.startsWith('/collab') ? COLLAB : WEB;
}

const front = createHttpsServer(tls, (incoming, outgoing) => {
  const host = (incoming.headers.host ?? '').split(':')[0];
  const forward = request(
    {
      host: '127.0.0.1',
      port: portOf(host, incoming.url ?? '/'),
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' },
    },
    (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(outgoing);
    },
  );
  forward.on('error', () => outgoing.destroy());
  incoming.pipe(forward);
});

// WebSocket (collaboration): the upgrade request is replayed on a raw connection.
front.on('upgrade', (incoming, socket, head) => {
  const host = (incoming.headers.host ?? '').split(':')[0];
  const target = connect(portOf(host, incoming.url ?? '/'), '127.0.0.1', () => {
    const headers = Object.entries(incoming.headers).map(([name, value]) => `${name}: ${value}`);
    target.write(`${incoming.method} ${incoming.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    target.write(head);
    target.pipe(socket).pipe(target);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

front.listen(0, '127.0.0.1', () => {
  const frontPort = front.address().port;
  const proxy = createHttpServer((_incoming, outgoing) => {
    outgoing.writeHead(405).end();
  });
  // Only the two hosts of the tests are tunnelled, both to the TLS front.
  proxy.on('connect', (incoming, socket, head) => {
    const [host, port] = (incoming.url ?? '').split(':');
    if ((host !== appHost && host !== filesHost) || port !== '443') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const target = connect(frontPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.write(head);
      target.pipe(socket).pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });
  proxy.listen(Number(proxyPort), '127.0.0.1', () => {
    console.log(`https-front: ${appHost} and ${filesHost} through 127.0.0.1:${proxyPort}`);
  });
});
