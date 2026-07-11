import { expect, test } from 'bun:test';
import os from 'node:os';

import type { Msg } from '../lib/protocol';
import { Session } from '../pt/session';

// One real shell on one real pty — slow (a shell start) but this is the
// heart of the workstation, so it earns its seconds.

async function until(what: string, probe: () => boolean, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (probe()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${what}`);
}

test('streams output live, replays it, and emits the exit frame on close', async () => {
  const session = new Session({ id: 't1', label: 't1', cwd: os.tmpdir(), command: '' });
  const frames: Msg[] = [];
  session.subscribe((msg) => frames.push(msg));

  session.write('echo pt_marker_1\r');
  await until('command output', () =>
    frames.some((f) => f.t === 'o' && String(f.d).includes('pt_marker_1')));

  // The scrollback ring must serve the same bytes to a late viewer.
  let replayed = '';
  let wasAlive = false;
  session.replay((data, alive) => {
    replayed = data;
    wasAlive = alive;
  });
  expect(replayed).toContain('pt_marker_1');
  expect(wasAlive).toBe(true);

  // Out-of-range resizes are ignored rather than passed to the pty.
  session.resize(0, 0);
  session.resize(10000, 10000);
  session.resize(120, 30);

  session.close();
  await until('exit frame', () => frames.some((f) => f.t === 'x'));
  expect(session.alive).toBe(false);
  session.replay((_data, alive, exitCode) => {
    expect(alive).toBe(false);
    expect(typeof exitCode).toBe('number');
  });
}, 40000);
