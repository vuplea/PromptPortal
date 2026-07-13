import fs from 'node:fs';
import path from 'node:path';

import { ClientError } from './errors';

const MAX_PROFILES = 100;

const DEFAULT_COMMANDS = [
  'claude',
  'codex',
  'claude --dangerously-skip-permissions',
  'codex --yolo',
];

// Seeded for the `server` workstation container; `node` left unset resolves
// to the chosen/sole workstation at launch.
const DEFAULT_PROFILES: Profile[] = [
  { name: 'ClaudeTmp', cwd: '/tmp', command: 'claude' },
  { name: 'CodexTmp', cwd: '/tmp', command: 'codex' },
  { name: 'ClaudeTmp Yolo', cwd: '/tmp', command: 'claude --dangerously-skip-permissions' },
  { name: 'CodexTmp Yolo', cwd: '/tmp', command: 'codex --yolo' },
];

export interface Profile {
  name: string;
  cwd: string;
  command?: string;
  node?: string;
}

interface StoreData {
  profiles: Profile[];
  commands: string[];
}

function isProfile(value: unknown): value is Profile {
  const p = value as Profile;
  return !!p && typeof p === 'object'
    && typeof p.name === 'string' && p.name.trim() !== ''
    && typeof p.cwd === 'string' && p.cwd.trim() !== ''
    && (p.command === undefined || typeof p.command === 'string')
    && (p.node === undefined || typeof p.node === 'string');
}

// Accepts only the expected shape. A structurally valid JSON file with the
// wrong types (e.g. profiles set to null) would otherwise load and then throw
// on the first .find/.filter, bricking the API; treat it like corrupt JSON.
function validate(parsed: unknown): StoreData | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const { profiles, commands } = parsed as StoreData;
  if (!Array.isArray(profiles) || !profiles.every(isProfile)) return null;
  if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string')) return null;
  return { profiles, commands };
}

// Persists profiles and quick commands as a single JSON file in the data dir.
export class Store {
  private file: string;
  private data: StoreData;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'store.json');
    this.data = {
      profiles: DEFAULT_PROFILES.map((p) => ({ ...p })),
      commands: [...DEFAULT_COMMANDS],
    };

    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    let clean;
    try {
      clean = validate(JSON.parse(raw));
    } catch {
      clean = null; // not valid JSON
    }
    if (clean) {
      this.data = clean;
    } else {
      const backup = `${this.file}.corrupt`;
      fs.copyFileSync(this.file, backup);
      console.warn(`store: ${this.file} is unreadable or malformed; backed it up to ${backup} and starting fresh`);
      // Write the defaults out too, or every restart re-reads the same
      // broken file and warns again.
      this.commit(this.data);
    }
  }

  // Write-to-temp-then-rename so a crash mid-write cannot corrupt the store.
  // Memory adopts the new state only once it is safely on disk: a failed save
  // (disk full) must not leave the API serving state that a restart would
  // silently revert.
  private commit(next: StoreData): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.data = next;
  }

  get profiles(): Profile[] { return this.data.profiles; }
  get commands(): string[] { return this.data.commands; }

  getProfile(name: string): Profile | undefined {
    return this.data.profiles.find((p) => p.name === name);
  }

  // Creates or updates a profile; `replace` names an existing profile this
  // one supersedes (used when a profile is renamed in the editor).
  upsertProfile({ name, cwd, command, node }: Profile, replace?: string): void {
    const profile = { name, cwd, command, node };
    let profiles = this.data.profiles;
    if (replace && replace !== name) {
      // A rename must not silently swallow a different profile that already
      // holds the target name.
      if (profiles.some((p) => p.name === name)) throw new ClientError(`a profile named "${name}" already exists`);
      profiles = profiles.filter((p) => p.name !== replace);
    }
    if (profiles.some((p) => p.name === name)) {
      profiles = profiles.map((p) => (p.name === name ? profile : p));
    } else {
      // Bounded like quick commands (server.ts): an authenticated browser
      // must not grow the store — and every state response — without limit.
      if (profiles.length >= MAX_PROFILES) throw new ClientError(`at most ${MAX_PROFILES} profiles`);
      profiles = [...profiles, profile];
    }
    this.commit({ ...this.data, profiles });
  }

  deleteProfile(name: string): void {
    this.commit({ ...this.data, profiles: this.data.profiles.filter((p) => p.name !== name) });
  }

  setCommands(commands: string[]): void {
    this.commit({ ...this.data, commands });
  }
}
