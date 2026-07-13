import path from 'node:path';

import { Auth } from './lib/auth';
import { Store } from './lib/store';
import { Directory, type PtSocket, type WsData } from './lib/directory';
import { ClientError } from './lib/errors';
import { BROWSER_PROTOCOL, LAUNCHER_PROTOCOL, MAX_FIELD_CHARS, NODE_NAME_RE, SESSION_PROTOCOL, parse, send } from './lib/protocol';

// The hub. It serves the browser UI, authenticates clients, and brokers
// between browser sockets and the terminal workstations registered with it.
// It hosts no terminals itself: every session is a `pt` process on a
// workstation that dials in over its own outbound WebSocket, and each
// workstation runs a small `pt launcher` so sessions can be started from
// here — including the `server` workstation container deployed beside the
// hub (see docker-compose.yml).

const PORT = Number(process.env.PORT) || 8080;
// Loopback by default: the hub speaks plain HTTP and Basic auth resends the
// password with every request, so a reachable-from-the-network listener is an
// explicit decision (HOST=0.0.0.0) to pair with TLS in front. The hub
// container sets it (Dockerfile.hub) and publishes the port loopback-bound
// instead (docker-compose.yml).
const HOST = process.env.HOST || '127.0.0.1';
// The two secrets: browsers present the web-access password via Basic auth
// (username "pocketterm"); workstation session and launcher sockets present
// the workstation password. See lib/auth.ts.
const WEBACCESS_PASSWORD = process.env.POCKETTERM_WEBACCESS_PASSWORD;
const WORKSTATION_PASSWORD = process.env.POCKETTERM_WORKSTATION_PASSWORD;
const DATA_DIR = process.env.POCKETTERM_DATA || path.join(import.meta.dir, 'data');
const TRUST_PROXY = ['1', 'true'].includes(process.env.POCKETTERM_TRUST_PROXY ?? '');

for (const [name, value] of [
  ['POCKETTERM_WEBACCESS_PASSWORD', WEBACCESS_PASSWORD],
  ['POCKETTERM_WORKSTATION_PASSWORD', WORKSTATION_PASSWORD],
] as const) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  // The placeholder is public knowledge (it ships in .env.example); a hub
  // guarded by it is a hub guarded by nothing.
  if (value === 'change-me-long-random') {
    console.error(`${name} is still the .env.example placeholder — set a real password`);
    process.exit(1);
  }
  // Each password gates a shell on every workstation; a short one falls to
  // online guessing despite the lockout.
  if (value.length < 16) {
    console.error(`${name} is too short — use at least 16 characters, long and random`);
    process.exit(1);
  }
}

const auth = new Auth(WEBACCESS_PASSWORD!, WORKSTATION_PASSWORD!);
const store = new Store(DATA_DIR);
const directory = new Directory();

// ---------------------------------------------------------------- static

const STATIC_FILES: Record<string, [string, string]> = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.js.map': ['node_modules/@xterm/xterm/lib/xterm.js.map', 'application/json'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/vendor/addon-fit.js.map': ['node_modules/@xterm/addon-fit/lib/addon-fit.js.map', 'application/json'],
};

// Applied to every HTTP response. style-src 'unsafe-inline' for xterm.js (its
// DOM renderer injects a style element); img-src data: for the inline SVG
// favicon.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function respond(status: number, body: string | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

function respondJson(status: number, body: unknown): Response {
  return respond(status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function readJsonBody(req: Request): Promise<any> {
  // Require a JSON content type. This is also the CSRF defense: a JSON body
  // is not a CORS "simple request", so a cross-origin caller triggers a
  // preflight this server never answers, and the browser blocks the request
  // before it reaches here — even though it would otherwise attach the
  // user's cached Basic-auth credentials. (Body size is capped by the
  // server's maxRequestBodySize.)
  const type = (req.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new ClientError('Content-Type must be application/json');
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError('invalid JSON');
  }
}

// ------------------------------------------------------------------- api

// The request body cap alone (64KB) would still admit absurd labels into the
// store and the UI; MAX_FIELD_CHARS (lib/protocol.ts) is the per-field bound.
const MAX_COMMANDS = 100;

function requireString(value: unknown, name: string, { optional = false } = {}): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.trim() === '') throw new ClientError(`"${name}" is required`);
  if (value.length > MAX_FIELD_CHARS) throw new ClientError(`"${name}" is too long (max ${MAX_FIELD_CHARS} characters)`);
  return value.trim();
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/state':
      return respondJson(200, {
        profiles: store.profiles,
        commands: store.commands,
        nodes: directory.launcherNames(),
        sessions: directory.listSessions(),
      });

    case 'GET /api/token':
      return respondJson(200, { token: auth.issueToken() });

    case 'POST /api/profiles': {
      const body = await readJsonBody(req);
      const profile = {
        name: requireString(body.name, 'name'),
        cwd: requireString(body.cwd, 'cwd'),
        command: requireString(body.command, 'command', { optional: true }),
        node: requireString(body.node, 'node', { optional: true }) || undefined,
      };
      store.upsertProfile(profile, typeof body.replace === 'string' ? body.replace : undefined);
      return respondJson(200, { ok: true });
    }

    case 'POST /api/profiles/delete': {
      const body = await readJsonBody(req);
      store.deleteProfile(requireString(body.name, 'name'));
      return respondJson(200, { ok: true });
    }

    case 'POST /api/commands': {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.commands) || body.commands.some((c: unknown) => typeof c !== 'string')) {
        throw new ClientError('"commands" must be an array of strings');
      }
      if (body.commands.length > MAX_COMMANDS) throw new ClientError(`at most ${MAX_COMMANDS} commands`);
      if (body.commands.some((c: string) => c.length > MAX_FIELD_CHARS)) {
        throw new ClientError(`each command must be at most ${MAX_FIELD_CHARS} characters`);
      }
      store.setCommands(body.commands.map((c: string) => c.trim()).filter(Boolean));
      return respondJson(200, { ok: true });
    }

    case 'POST /api/sessions': {
      const body = await readJsonBody(req);
      let { label, cwd, command, node } = body;
      if (body.profile) {
        const profile = store.getProfile(body.profile);
        if (!profile) return respondJson(404, { error: `profile "${body.profile}" not found` });
        ({ name: label, cwd, command, node } = profile);
      }
      // The cwd is validated on the target workstation (its own filesystem), so
      // a bad directory surfaces as a 400 here. label/command must be validated
      // as strings here, though: a non-string serializes into a frame the
      // launcher's parser rejects wholesale, which would surface as a 10s
      // timeout instead of a 400.
      // An explicit node in the body wins over a profile's pinned workstation.
      const created = await directory.createSession(requireString(body.node, 'node', { optional: true }) || node, {
        label: requireString(label, 'label', { optional: true }),
        cwd: requireString(cwd, 'cwd'),
        command: requireString(command, 'command', { optional: true }),
      });
      return respondJson(200, created);
    }

    case 'POST /api/sessions/delete': {
      const body = await readJsonBody(req);
      const conn = directory.get(requireString(body.id, 'id'));
      if (!conn) return respondJson(404, { error: 'session not found' });
      conn.kill();
      return respondJson(200, { ok: true });
    }

    default:
      return respondJson(404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------- server

// The brute-force lockout keys on client IP. Behind a reverse proxy every
// request arrives from the proxy's address, so one attacker would lock out
// everyone; POCKETTERM_TRUST_PROXY says the proxy is trusted to append the real
// client IP to X-Forwarded-For.
let warnedForwarded = false;
function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (TRUST_PROXY) {
    if (forwarded) return forwarded.split(',').pop()!.trim();
  } else if (!warnedForwarded && forwarded) {
    warnedForwarded = true;
    console.warn('auth: requests carry X-Forwarded-For but POCKETTERM_TRUST_PROXY is unset;'
      + ' lockouts key on the proxy address, so one attacker locks out everyone');
  }
  return server.requestIP(req)?.address ?? 'unknown';
}

function authFailure(result: { status: 401 | 429; retryAfter?: number }): Response {
  if (result.status === 429) {
    return respond(429, `Too many failed attempts. Retry in ${result.retryAfter}s.`, {
      'Retry-After': String(result.retryAfter),
      'Content-Type': 'text/plain',
    });
  }
  return respond(401, 'Authentication required. Sign in as "pocketterm" with the web-access password.', {
    'WWW-Authenticate': 'Basic realm="PocketTerminal (username: pocketterm)", charset="UTF-8"',
    'Content-Type': 'text/plain',
  });
}

function offeredProtocols(req: Request): string[] {
  return (req.headers.get('sec-websocket-protocol') || '').split(',').map((p) => p.trim());
}

// Three upgrade endpoints share the port, told apart by path:
//   /ws?session=<id>   a browser attaching to a session (token auth)
//   /session           a session host registering (node-secret auth)
//   /launcher?name=<n> a workstation launcher registering (node-secret auth)
// Each carries its secret in a Sec-WebSocket-Protocol slot, out of the URL.
function handleUpgrade(req: Request, url: URL): Response | undefined {
  const offered = offeredProtocols(req);

  if (url.pathname === '/session' || url.pathname === '/launcher') {
    const marker = url.pathname === '/session' ? SESSION_PROTOCOL : LAUNCHER_PROTOCOL;
    // The workstation presents the password base64url-encoded (subprotocol
    // values must be HTTP tokens; the encoding frees the password's charset).
    const presented = offered.find((p) => p && p !== marker) || '';
    const gate = auth.checkPassword(Buffer.from(presented, 'base64url'), clientIp(req));
    if (!gate.ok) {
      return respond(gate.status, gate.status === 429 ? 'Too Many Requests' : 'Unauthorized');
    }
    const name = url.searchParams.get('name') || '';
    if (url.pathname === '/launcher' && !NODE_NAME_RE.test(name)) {
      return respond(400, 'Bad Request');
    }
    const ok = server.upgrade(req, {
      headers: { 'Sec-WebSocket-Protocol': marker },
      data: url.pathname === '/session'
        ? { kind: 'session', conn: null, isAlive: true }
        : { kind: 'launcher', name, isAlive: true },
    });
    return ok ? undefined : respond(400, 'Bad Request');
  }

  if (url.pathname === '/ws') {
    const session = url.searchParams.get('session');
    const token = offered.find((p) => p && p !== BROWSER_PROTOCOL);
    // Check the session first: a vanished session must not burn the
    // single-use token, so the client's retry can still succeed.
    const conn = session ? directory.get(session) : undefined;
    if (!conn || !auth.consumeToken(token)) {
      return respond(401, 'Unauthorized');
    }
    const ok = server.upgrade(req, {
      headers: { 'Sec-WebSocket-Protocol': BROWSER_PROTOCOL },
      data: { kind: 'browser', conn, clientId: null, isAlive: true },
    });
    return ok ? undefined : respond(400, 'Bad Request');
  }

  return respond(404, 'Not Found');
}

// Input is keystrokes and pastes; a browser frame has no business being huge.
const MAX_BROWSER_FRAME_BYTES = 1024 * 1024;

// Every open socket, for the liveness reaper below.
const liveSockets = new Set<PtSocket>();

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,
  // API bodies are small JSON; nothing else takes a body.
  maxRequestBodySize: 64 * 1024,

  async fetch(req) {
    // new URL(req.url) can throw on request targets the HTTP parser accepts
    // but the WHATWG parser rejects — and this runs before auth.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return respond(400, 'Bad request.', { 'Content-Type': 'text/plain' });
    }

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return handleUpgrade(req, url);
    }

    const gate = auth.check(req.headers.get('authorization') ?? undefined, clientIp(req));
    if (!gate.ok) return authFailure(gate);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, url);
      } catch (err) {
        if (err instanceof ClientError) return respondJson(400, { error: err.message });
        // An unexpected fault (e.g. the store failing to write): log it, but
        // don't hand the client a misleading 400 or the raw message.
        console.error(`hub: api ${req.method} ${url.pathname}: ${(err as Error).message}`);
        return respondJson(500, { error: 'internal error' });
      }
    }

    const entry = STATIC_FILES[url.pathname];
    if (entry && (req.method === 'GET' || req.method === 'HEAD')) {
      const [file, type] = entry;
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
      if (req.method === 'HEAD') return respond(200, null, headers);
      const blob = Bun.file(path.join(import.meta.dir, file));
      if (!(await blob.exists())) {
        console.error(`static: ${file}: not found`);
        return respond(500, 'Failed to read file.', { 'Content-Type': 'text/plain' });
      }
      return new Response(blob, { headers: { ...BASE_HEADERS, ...headers } });
    }

    return respond(404, 'Not found.', { 'Content-Type': 'text/plain' });
  },

  // A thrown handler must not take the hub down — every browser view and
  // workstation link hangs off this process (the sessions themselves live on
  // their workstations and would survive, unreachable).
  error(err) {
    console.error(`hub: ${err.message}`);
    return respond(500, 'Internal error.', { 'Content-Type': 'text/plain' });
  },

  websocket: {
    maxPayloadLength: 16 * 1024 * 1024, // a build-log firehose from a session, not a browser frame
    // The reaper below is what detects dead peers; this is only a backstop,
    // and it must not outpace the 30s ping interval.
    idleTimeout: 480,

    open(ws: PtSocket) {
      liveSockets.add(ws);
      const data = ws.data;
      if (data.kind === 'launcher') {
        directory.registerLauncher(data.name, ws);
        console.log(`hub: workstation "${data.name}" connected`);
      } else if (data.kind === 'browser') {
        // The session can drop between upgrade and open; a watcher of a dead
        // connection would never be cleaned up.
        if (data.conn.ws.readyState !== 1) return ws.close();
        data.conn.attachBrowser(ws);
      }
      // A session socket registers with its first frame.
    },

    message(ws: PtSocket, raw: string | Buffer) {
      const data = ws.data;
      // A text frame's .length counts UTF-16 code units, not bytes; cap bytes.
      if (data.kind === 'browser'
        && (typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length) > MAX_BROWSER_FRAME_BYTES) {
        return ws.terminate();
      }
      const msg = parse(raw);
      if (!msg) return;
      switch (data.kind) {
        case 'session':
          if (data.conn) {
            data.conn.handleMessage(msg);
          } else if (msg.t === 'register') {
            data.conn = directory.registerSession(ws, msg.session);
            if (!data.conn) return ws.close();
            // JSON.stringify keeps control characters in these remote strings
            // from forging log lines or escaping into the operator's terminal.
            console.log(`hub: session ${JSON.stringify(data.conn.info.label)} on ${JSON.stringify(data.conn.info.node)} connected`);
          }
          break;
        case 'launcher':
          directory.handleLauncherMessage(msg);
          break;
        case 'browser':
          data.conn.handleBrowserMessage(msg);
          break;
      }
    },

    close(ws: PtSocket) {
      liveSockets.delete(ws);
      const data = ws.data;
      if (data.kind === 'session') {
        if (data.conn) directory.unregisterSession(data.conn);
      } else if (data.kind === 'launcher') {
        directory.unregisterLauncher(data.name, ws);
      } else {
        data.conn.detachBrowser(data.clientId, ws);
      }
    },

    pong(ws: PtSocket) {
      ws.data.isAlive = true;
    },
  },
});

// Drop peers that vanished without a close frame (phone lost signal, the
// workstation slept) so nothing accumulates dead sockets. Every peer also
// gets a {t:'ping'} frame: WS-level pings are answered below the JS layer on
// both ends, so only an application frame lets a workstation (pt/link.ts) or
// a page (public/app.js) tell a silent hub from a dead link.
setInterval(() => {
  for (const ws of liveSockets) {
    if (!ws.data.isAlive) { ws.terminate(); continue; }
    ws.data.isAlive = false;
    ws.ping();
    send(ws, { t: 'ping' });
  }
}, 30 * 1000).unref();

// ------------------------------------------------------------- lifecycle

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: shutting down`);
    server.stop();
    process.exit(0);
  });
}

console.log(`PocketTerminal hub listening on http://${HOST}:${PORT}`);

// The hub itself speaks plain HTTP, and Basic auth resends the password with
// every request — so a non-loopback listener is only safe with TLS
// terminating in front (reverse proxy, tailscale serve, or a private compose
// network). Say so at startup; the bare quickstart is one missed README
// paragraph away from broadcasting the password on the LAN.
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.warn('hub: listening on a non-loopback address over plain HTTP — every request'
    + ' carries the password, so TLS must terminate in front (reverse proxy or VPN);'
    + ' set HOST=127.0.0.1 if a local proxy is the only way in');
}
