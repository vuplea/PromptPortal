import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NODE_NAME_RE } from '../lib/protocol';

// Configuration shared by the pt commands, read from the environment (the
// Windows installer persists these as user variables; the compose file passes
// them to the `server` workstation container).

export const isWindows = process.platform === 'win32';

export const env = {
  get hubUrl(): string { return process.env.POCKETTERM_HUB_URL ?? ''; },
  get password(): string { return process.env.POCKETTERM_PASSWORD ?? ''; },
  // The container (and the launcher, spawning headless hosts) hands the hub
  // password over stdin instead of the environment.
  get passwordFromStdin(): boolean {
    return ['1', 'true'].includes(process.env.POCKETTERM_PASSWORD_STDIN ?? '');
  },
  get nodeName(): string { return process.env.POCKETTERM_NODE_NAME ?? ''; },
  // The shell each session hosts. Empty means the platform default
  // (powershell.exe on Windows, $SHELL/bash elsewhere) — see pt/session.ts.
  get shell(): string { return process.env.POCKETTERM_SHELL ?? ''; },
};

// This workstation's name: POCKETTERM_NODE_NAME, or the hostname lowercased
// with non-conforming chars turned into '-'.
export function resolveNodeName(): string {
  const configured = env.nodeName;
  if (configured) {
    if (!NODE_NAME_RE.test(configured)) {
      throw new CliError(`Invalid POCKETTERM_NODE_NAME "${configured}" (allowed: letters, digits, _ . -)`);
    }
    return configured;
  }
  const name = (os.hostname() || 'workstation')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return name.length > 0 ? name : 'workstation';
}

function expandHome(dir: string): string {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

// A session's working directory, as given by the user or the phone: ~ and
// relative paths resolved, and required to exist.
export function resolveExistingDir(dir: string): string {
  const resolved = path.resolve(expandHome(dir));
  let isDir;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new CliError(`directory does not exist: ${resolved}`);
  return resolved;
}

// Read a secret piped on stdin (the launcher's pipe to a headless host, the
// entrypoint's heredoc). Strips only the single trailing newline the pipe
// adds — nothing else, since every other byte of the password is significant.
export async function readSecretFromStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/[\r\n]+$/, '');
}

// An error meant for the user, printed without a stack trace.
export class CliError extends Error {}
