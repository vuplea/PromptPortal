import { readCredential, writeCredential } from './credential';
import { CliError } from './errors';
import { promptHidden } from './secret';

// Hub process settings: a small CLI and the two passwords. Flags exist
// because a hub installed as a Windows background task (windows/install.ps1)
// has no clean per-process environment channel — PORT and HOST are too
// generic to persist user-wide — so the task passes them on the command
// line; each flag overrides its environment variable.

export const isWindows = process.platform === 'win32';

export const HUB_USAGE = 'hub [--port N] [--host ADDR] [--data DIR] | hub set-password';

export interface HubCli {
  port?: number;
  host?: string;
  data?: string;
}

export function parseHubCli(argv: string[]): HubCli {
  const cli: HubCli = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${flag} needs a value — usage: ${HUB_USAGE}`);
      return v;
    };
    switch (flag) {
      case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CliError('--port must be an integer between 1 and 65535');
        }
        cli.port = port;
        break;
      }
      case '--host':
        cli.host = value();
        break;
      case '--data':
        cli.data = value();
        break;
      default:
        throw new CliError(`unknown argument "${flag}" — usage: ${HUB_USAGE}`);
    }
  }
  return cli;
}

// ------------------------------------------------------------- passwords

// The two secrets the hub gates on (lib/auth.ts). Each comes from its
// environment variable, or — on Windows, where the hub can run as an
// installed background task — from Credential Manager, written by
// `hub set-password`. The environment wins, so a container or a dev run is
// never surprised by a stored credential.
const HUB_PASSWORDS = [
  {
    key: 'webaccess',
    label: 'web-access',
    envVar: 'POCKETTERM_WEBACCESS_PASSWORD',
    target: 'PocketTerminalHub/webaccess',
    promptLabel: 'Web-access password (browsers sign in with it)',
  },
  {
    key: 'workstation',
    label: 'workstation',
    envVar: 'POCKETTERM_WORKSTATION_PASSWORD',
    target: 'PocketTerminalHub/workstation',
    promptLabel: 'Workstation password (workstations register with it)',
  },
] as const;

// Why a password is unusable, phrased to follow its name — or null if it is
// fine. Each password gates a shell on every workstation: the placeholder is
// public knowledge (it ships in .env.example), and a short one falls to
// online guessing despite the brute-force lockout.
export function passwordProblem(value: string): string | null {
  if (value === 'change-me-long-random') return 'is still the .env.example placeholder — set a real password';
  if (value.length < 16) return 'is too short — use at least 16 characters, long and random';
  return null;
}

// Resolve and validate both passwords. Problems come back as messages rather
// than a throw so startup can report every misconfiguration at once.
export function resolveHubPasswords(): { webaccess: string; workstation: string; problems: string[] } {
  const resolved = { webaccess: '', workstation: '' };
  const problems: string[] = [];
  for (const cred of HUB_PASSWORDS) {
    const value = process.env[cred.envVar] || (isWindows ? readCredential(cred.target) ?? '' : '');
    if (!value) {
      problems.push(`Missing ${cred.envVar} — set the environment variable`
        + (isWindows ? ' or run "hub set-password"' : ''));
      continue;
    }
    const problem = passwordProblem(value);
    if (problem) {
      problems.push(`${cred.envVar} ${problem}`);
      continue;
    }
    resolved[cred.key] = value;
  }
  return { ...resolved, problems };
}

// `hub set-password` — store both passwords in Windows Credential Manager,
// where a hub installed as a background task reads them from. Piped input
// (the installer: web-access then workstation, one per line) or hidden
// prompts. An empty entry keeps the already-stored credential, so a re-run
// only retypes what changes.
export async function setHubPasswords(): Promise<void> {
  if (!isWindows) {
    throw new CliError('set-password uses Windows Credential Manager; on this platform set'
      + ' POCKETTERM_WEBACCESS_PASSWORD and POCKETTERM_WORKSTATION_PASSWORD instead');
  }
  const interactive = process.stdin.isTTY === true;
  const lines = interactive ? [] : (await Bun.stdin.text()).split(/\r?\n/);
  let changed = false;
  for (const [i, cred] of HUB_PASSWORDS.entries()) {
    const stored = readCredential(cred.target) !== null;
    const entered = interactive
      ? await promptHidden(`${cred.promptLabel}${stored ? ' (Enter keeps the stored one)' : ''}: `)
      : lines[i] ?? '';
    if (entered.length === 0) {
      if (!stored) throw new CliError(`no ${cred.label} password given and none stored`);
      console.log(`Kept the stored ${cred.label} password.`);
      continue;
    }
    const problem = passwordProblem(entered);
    if (problem) throw new CliError(`the ${cred.label} password ${problem}`);
    writeCredential(cred.target, entered);
    changed = true;
    console.log(`Stored the ${cred.label} password in Credential Manager (generic credential "${cred.target}").`);
  }
  // The hub hashes its passwords at startup (lib/auth.ts), so a rotation
  // reaches an already-running hub only at its next restart. The installer
  // pipes (non-interactive) and restarts the task itself right after.
  if (interactive && changed) {
    console.log('An already-running hub picks the change up at its next restart.');
  }
}
