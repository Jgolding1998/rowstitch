/** Read-only loopback transport for the fictional demo. Never accepts SQL or file paths. */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export interface StudioOptions {
  port: number;
  getDemo: () => unknown;
}

const MAX_JSON = 2 * 1024 * 1024;
const MAX_ASSET = 1024 * 1024;
const MAX_ACTIVE = 16;
const CONNECTION_LIFETIME = 5_000;
const USED_SOCKETS = new WeakSet<Duplex>();
const HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  Connection: 'close',
});
const ASSETS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/mark.svg': ['mark.svg', 'image/svg+xml'],
});

function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name) values.push(request.rawHeaders[index + 1]!);
  }
  return values;
}

function reply(request: IncomingMessage, response: ServerResponse, status: number, content: Buffer | string,
  type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': bytes.length, ...extra });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

function error(request: IncomingMessage, response: ServerResponse, status: number, message: string,
  extra?: Record<string, string>): void {
  reply(request, response, status, JSON.stringify({ error: message }), undefined, extra);
}

function refuseSocket(socket: Duplex, status: 400 | 405 | 408 | 431): void {
  // A parser error after an already admitted request must not append a second response.
  if (USED_SOCKETS.has(socket)) return;
  if (socket.destroyed || !socket.writable) { socket.destroy(); return; }
  USED_SOCKETS.add(socket);
  const body = JSON.stringify({ error: 'This HTTP request is not supported.' });
  const reason = status === 431 ? 'Request Header Fields Too Large' : status === 405 ? 'Method Not Allowed' : status === 408 ? 'Request Timeout' : 'Bad Request';
  const headers = { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) };
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n${body}`);
}

/** Starts asynchronously; callers may await the Server's 'listening' event and use address()/close(). */
export function startStudio(options: StudioOptions): Server {
  if (!options || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new RangeError('Studio port must be an integer from 0 through 65535.');
  }
  if (typeof options.getDemo !== 'function') throw new TypeError('Studio requires a synchronous demo provider.');
  let active = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.on('error', () => request.destroy());
    response.on('error', () => response.destroy());
    // Bodies have no meaning for this interface; drain rejected input without retaining it.
    request.resume();
    const hosts = headerValues(request, 'host');
    const port = request.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (port === 80) { allowedHosts.add('127.0.0.1'); allowedHosts.add('localhost'); }
    const host = hosts.length === 1 ? hosts[0]!.toLowerCase() : '';
    if (!allowedHosts.has(host)) { error(request, response, 403, 'Use the local address printed by Rowstitch.'); return; }
    const origins = headerValues(request, 'origin');
    const sites = headerValues(request, 'sec-fetch-site');
    if (origins.length > 1 || origins.length === 1 && origins[0] !== new URL(`http://${host}`).origin
      || sites.length > 1 || sites.some(site => site !== 'same-origin' && site !== 'none')) {
      error(request, response, 403, 'Use Rowstitch from its own local page.'); return;
    }
    if (request.rawHeaders.length > 100) { error(request, response, 431, 'Use fewer request headers.'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      error(request, response, 405, 'Studio is read-only.', { Allow: 'GET, HEAD' }); return;
    }
    const lengths = headerValues(request, 'content-length');
    if (headerValues(request, 'transfer-encoding').length || headerValues(request, 'expect').length
      || lengths.length > 1 || lengths.some(value => !/^0+$/.test(value))) {
      error(request, response, 400, 'Studio does not accept request bodies.'); return;
    }
    const target = request.url ?? '';
    if (target.length > 2048 || !target.startsWith('/') || target.startsWith('//') || /[\\%#?]/.test(target)) {
      error(request, response, 400, 'Use a local Studio path.'); return;
    }
    const route = target;
    if (route !== '/api/demo' && !Object.hasOwn(ASSETS, route)) {
      error(request, response, 404, 'This Studio page does not exist.'); return;
    }
    if (active >= MAX_ACTIVE) { error(request, response, 503, 'Studio is busy. Try again shortly.'); return; }
    active += 1;
    try {
      if (route === '/api/demo') {
        const document = options.getDemo();
        if (document && typeof (document as { then?: unknown }).then === 'function') {
          // An accidentally async provider may reject: consume that rejection before failing safely.
          void Promise.resolve(document).catch(() => {});
          throw new Error('Async demo provider');
        }
        const json = JSON.stringify(document);
        if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_JSON) throw new Error('Invalid demo size');
        reply(request, response, 200, json);
      } else {
        const [filename, mime] = ASSETS[route]!;
        const bytes = await readFile(new URL(`../studio/${filename}`, import.meta.url));
        if (bytes.length > MAX_ASSET) throw new Error('Invalid asset size');
        reply(request, response, 200, bytes, mime);
      }
    } catch {
      error(request, response, 500, 'Studio could not prepare this page. Restart Rowstitch and try again.');
    } finally { active -= 1; }
  }

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    // Every response closes its connection. Ignore pipelined requests rather than executing
    // another provider or writing data after the first Connection: close response.
    if (USED_SOCKETS.has(request.socket)) { request.resume(); return; }
    USED_SOCKETS.add(request.socket);
    void handle(request, response).catch(() => error(request, response, 500, 'Studio could not prepare this page.'));
  };
  const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 250 }, listener);
  server.headersTimeout = 3_000;
  server.requestTimeout = CONNECTION_LIFETIME;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 0; // Count all headers ourselves within the parser's byte limit.
  server.maxConnections = 32;
  server.setTimeout(CONNECTION_LIFETIME, socket => socket.destroy());
  server.on('connection', socket => {
    const deadline = setTimeout(() => socket.destroy(), CONNECTION_LIFETIME);
    deadline.unref();
    socket.once('close', () => clearTimeout(deadline));
  });
  server.on('checkContinue', listener);
  server.on('checkExpectation', listener);
  server.on('clientError', (failure: Error & { code?: string }, socket) => {
    refuseSocket(socket, failure.code === 'HPE_HEADER_OVERFLOW' ? 431 : failure.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400);
  });
  server.on('upgrade', (_request, socket) => refuseSocket(socket, 400));
  server.on('connect', (_request, socket) => refuseSocket(socket, 405));
  server.listen({ port: options.port, host: '127.0.0.1', backlog: 16 });
  return server;
}
