import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError } from '../lib/errors';
import { NODE_NAME_RE } from '../lib/protocol';

// Configuration shared by the promptportal commands, read from the environment (the
// Windows installer persists these as user variables; the compose file passes
// them to the `server` workstation container).

// Re-exported so promptportal code keeps one import site for its user-facing error.
export { CliError };

export const isWindows = process.platform === 'win32';

// The workstation password's home on Windows: a generic credential in the
// user's Credential Manager (lib/credential.ts), written by `promptportal set-password`
// and read back by every session host and the launcher.
export const CREDENTIAL_TARGET = 'PromptPortal';

export const env = {
  get hubUrl(): string { return process.env.PROMPTPORTAL_HUB_URL ?? ''; },
  get password(): string { return process.env.PROMPTPORTAL_WORKSTATION_PASSWORD ?? ''; },
  // The container (and the launcher, spawning headless hosts) hands the
  // workstation password over stdin instead of the environment.
  get passwordFromStdin(): boolean {
    return ['1', 'true'].includes(process.env.PROMPTPORTAL_PASSWORD_STDIN ?? '');
  },
  get nodeName(): string { return process.env.PROMPTPORTAL_NODE_NAME ?? ''; },
  // The shell each session hosts. Empty means the platform default
  // (powershell.exe on Windows, $SHELL/bash elsewhere) — see promptportal/session.ts.
  get shell(): string { return process.env.PROMPTPORTAL_SHELL ?? ''; },
};

// This workstation's name: PROMPTPORTAL_NODE_NAME, or the hostname lowercased
// with non-conforming chars turned into '-'.
export function resolveNodeName(): string {
  const configured = env.nodeName;
  if (configured) {
    if (!NODE_NAME_RE.test(configured)) {
      throw new CliError(`Invalid PROMPTPORTAL_NODE_NAME "${configured}" (allowed: letters, digits, _ . -)`);
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
