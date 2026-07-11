import fs from 'node:fs';

import { CliError, env, isWindows, readSecretFromStdin, resolveNodeName } from './config';
import { readCredential } from './credential';
import { runHost, type HostContext, type HostSpec } from './host';
import { runLauncher } from './launcher';
import { normalizeHubUrl, warnIfCleartext } from './link';
import { setPassword } from './password';

//   pt [label] [--cwd DIR] [-- CMD ARGS...]    host a session in this terminal
//                          (everything after -- is the command, verbatim —
//                           no quoting)
//   pt launcher            run the workstation launcher (a logon task on
//                          Windows, the container entrypoint) so sessions can
//                          be started from the hub
//   pt set-password        store the hub password in Credential Manager (Windows)
//
// (internal)  pt run --spec <b64url-json>      host a session from a launcher spec
//
// A session lives exactly as long as its `pt` process: close the window (or
// kill it from the hub) and the shell dies with it.

const USAGE = 'pt [label] [--cwd DIR] [-- CMD ARGS...] | pt launcher | pt set-password';

const args = process.argv.slice(2);

// The hub secret is kept out of this process's environment: same-user
// processes can read /proc/<pid>/environ, which deleting the variable does not
// clear. The launcher hands it to headless hosts over stdin (see
// workstation-entrypoint.sh); on Windows it lives in Credential Manager
// (`pt set-password`, written by the installer). The delete below still clears
// a POCKETTERM_PASSWORD set directly in the environment, so a session's shell
// doesn't inherit it.
async function resolvePassword(): Promise<string> {
  let password = env.password;
  delete process.env.POCKETTERM_PASSWORD;
  if (password.length === 0 && env.passwordFromStdin) {
    password = await readSecretFromStdin();
    // stdin here carries the secret (a shell heredoc's temp file, or the
    // launcher's pipe) and stays readable via /proc/<pid>/fd/0. Repoint fd 0 at
    // /dev/null to release it once read.
    if (!isWindows) {
      try {
        fs.closeSync(0);
        fs.openSync('/dev/null', 'r'); // POSIX: open reclaims the lowest fd — 0
      } catch {}
    }
  }
  if (password.length === 0 && isWindows) {
    password = readCredential() ?? '';
  }
  return password;
}

// A launcher spec pins hubUrl and node, so a spawned session registers with
// exactly the hub that asked for it; everything else comes from the
// environment.
async function workstationContext(spec: HostSpec = {}): Promise<HostContext> {
  const node = spec.node || resolveNodeName();
  const hubUrl = spec.hubUrl ?? (env.hubUrl.length > 0 ? normalizeHubUrl(env.hubUrl) : '');
  if (hubUrl) warnIfCleartext(hubUrl);
  return { hubUrl, password: hubUrl ? await resolvePassword() : '', node };
}

// A missing password is fatal for the launcher (it exists only to serve the
// hub) but not for a session: the window should still be a working terminal,
// just unlinked.
function requirePassword(ctx: HostContext): HostContext {
  if (ctx.password.length > 0) return ctx;
  throw new CliError('POCKETTERM_HUB_URL is set but no hub password was found'
    + (isWindows ? ' (run `pt set-password`, or set POCKETTERM_PASSWORD)' : ' (set POCKETTERM_PASSWORD)'));
}

async function hostSession(spec: HostSpec): Promise<never> {
  let ctx = await workstationContext(spec);
  if (ctx.hubUrl && ctx.password.length === 0) {
    try {
      requirePassword(ctx);
    } catch (err) {
      console.error(`${(err as CliError).message} — running unlinked`);
      ctx = { ...ctx, hubUrl: '' };
    }
  }
  return runHost(spec, ctx);
}

function parseHostArgs(rest: string[]): HostSpec {
  const spec: HostSpec = {};
  const labelParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      // Everything right of -- is the command, verbatim: no escaping a
      // nested command line from the outer shell.
      const command = rest.slice(i + 1).join(' ');
      if (command) spec.command = command;
      break;
    }
    if (rest[i] === '--cwd' && i + 1 < rest.length) spec.cwd = rest[++i]!;
    else labelParts.push(rest[i]!);
  }
  if (labelParts.length > 0) spec.label = labelParts.join(' ');
  return spec;
}

function parseSpec(rest: string[]): HostSpec {
  const encoded = rest[0] === '--spec' ? rest[1] : undefined;
  if (!encoded) throw new CliError('run needs --spec');
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as HostSpec;
  } catch {
    throw new CliError('malformed --spec');
  }
}

try {
  switch (args[0]) {
    case 'launcher': {
      const ctx = await workstationContext();
      if (!ctx.hubUrl) throw new CliError('POCKETTERM_HUB_URL is not set — the launcher exists only to serve a hub');
      await runLauncher(requirePassword(ctx));
      break;
    }
    case 'run':
      await hostSession(parseSpec(args.slice(1)));
      break;
    case 'set-password':
      await setPassword();
      break;
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      // Headless hosting is reserved for launcher specs (`pt run`): a bare
      // `pt` in a script or healthcheck must not silently spawn an invisible
      // shell.
      if (process.stdin.isTTY !== true) {
        throw new CliError('pt hosts a session in the terminal it runs in, and no terminal is attached'
          + ` — usage: ${USAGE}`);
      }
      await hostSession(parseHostArgs(args));
      break;
  }
  process.exit(0);
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  console.error(err.message);
  process.exit(1);
}
