import path from 'node:path';

import { LAUNCHER_PROTOCOL, type Msg } from '../lib/protocol';
import { isWindows, resolveExistingDir } from './config';
import { maintainLink } from './link';
import type { HostContext } from './host';
import { openHostWindow } from './window';

// `pt launcher` — the one resident process per workstation, and the only
// reason one exists: starting sessions from the phone. It keeps a single
// outbound WebSocket to the hub and answers create requests by spawning a
// `pt` host — in a terminal window on a Windows desktop (the window is the
// session), headless in the workstation container. It relays no terminal
// traffic and owns nothing: stopping it strands no sessions.

// Compiled (`bun build --compile`, the installed pt.exe) the executable is
// the program; under `bun pt/main.ts` in development the script path must be
// passed along.
const COMPILED = !/^bun(\.exe)?$/i.test(path.basename(process.execPath));

function hostArgs(spec: string): string[] {
  const args = ['run', '--spec', spec];
  return COMPILED ? args : [process.argv[1]!, ...args];
}

export async function runLauncher(ctx: HostContext): Promise<never> {
  console.log(`launcher: workstation "${ctx.node}" ready`);
  const url = `${ctx.hubUrl}/launcher?name=${encodeURIComponent(ctx.node)}`;
  return maintainLink(url, LAUNCHER_PROTOCOL, ctx.password, {
    onOpen() {
      console.log(`launcher: linked to hub as "${ctx.node}"`);
    },
    onMessage(msg, post) {
      if (msg.t !== 'create' || typeof msg.id !== 'string') return;
      try {
        create(msg, ctx);
      } catch (err) {
        post({ t: 'created', id: msg.id, error: (err as Error).message });
      }
    },
  });
}

// Spawn the host for one create request. Success is never reported from
// here — the session registers itself with the hub; only a spawn that
// definitely failed answers (so the phone sees the error instead of a
// timeout). The cwd is checked here for the same reason.
function create(msg: Msg, ctx: HostContext): void {
  const cwd = resolveExistingDir(msg.cwd || '');

  // The spec carries the session's full context, so a spawned host registers
  // with exactly the hub that asked for it — never with whatever POCKETTERM_*
  // values happen to sit in an inherited environment.
  const spec = Buffer.from(JSON.stringify({
    id: msg.id,
    label: msg.label || undefined,
    cwd,
    command: msg.command || undefined,
    hubUrl: ctx.hubUrl,
    node: ctx.node,
  })).toString('base64url');

  if (isWindows) {
    // A visible window: the session must be closable (and killable) by
    // closing it. The host reads the hub password from Credential Manager
    // itself.
    openHostWindow(hostArgs(spec));
    return;
  }

  // No windows here (the workstation container): a headless host. The hub
  // password goes over stdin rather than the environment.
  const child = Bun.spawn({
    cmd: [process.execPath, ...hostArgs(spec)],
    env: { ...process.env, POCKETTERM_PASSWORD_STDIN: '1' },
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  // The pipe settles asynchronously: a host that dies before reading its
  // stdin rejects these after create() has returned, where an unguarded
  // rejection would take down the launcher itself.
  (async () => {
    await child.stdin.write(ctx.password + '\n');
    await child.stdin.end();
  })().catch(() => {}); // the host is dead; the create surfaces as a timeout
  child.unref();
}
