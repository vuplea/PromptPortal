import { BASIC_USERNAME } from '../lib/protocol';
import { CliError, env, isWindows, readSecretFromStdin } from './config';
import { CREDENTIAL_TARGET, writeCredential } from './credential';
import { normalizeHubUrl, warnIfCleartext } from './link';

// `pt set-password` — store the hub password in Windows Credential Manager,
// where hosts and the launcher read it from, instead of an environment
// variable. Piped input (the installer) or a hidden prompt. The password is
// proved against the configured hub before it is stored: a wrong one written
// here would leave the launcher silently redialing forever.

export async function setPassword(): Promise<void> {
  if (!isWindows) {
    throw new CliError('set-password uses Windows Credential Manager; on this platform set POCKETTERM_PASSWORD instead');
  }
  const password = process.stdin.isTTY
    ? await promptHidden('Hub password: ')
    : await readSecretFromStdin();
  if (password.length === 0) throw new CliError('no password given');
  await verifyPassword(password);
  writeCredential(password);
  console.log(`Stored the hub password in Credential Manager (generic credential "${CREDENTIAL_TARGET}").`);
}

// The hub authenticates every HTTP request with Basic auth (lib/auth.ts), so
// one GET proves the password end-to-end — the same credential its WebSocket
// links present.
async function verifyPassword(password: string): Promise<void> {
  if (env.hubUrl.length === 0) {
    console.log('POCKETTERM_HUB_URL is not set; storing the password unverified.');
    return;
  }
  const normalized = normalizeHubUrl(env.hubUrl);
  // A cleartext hub URL puts the Basic credential readable on the wire right
  // here — say so before sending it, the same warning the link prints.
  warnIfCleartext(normalized);
  const url = `${normalized.replace(/^ws/, 'http')}/api/state`;
  let status: number;
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${BASIC_USERNAME}:${password}`).toString('base64') },
      signal: AbortSignal.timeout(10 * 1000),
    });
    status = res.status;
  } catch (err) {
    throw new CliError(`could not reach the hub to verify the password (${url}): ${(err as Error).message}`);
  }
  if (status === 401) throw new CliError('the hub rejected this password — not stored');
  if (status === 429) throw new CliError('the hub is rate-limiting sign-ins from this address; wait out the lockout and retry');
  if (status !== 200) throw new CliError(`unexpected answer verifying the password: HTTP ${status} from ${url}`);
}

// Bytes are scanned for the control keys (safe: UTF-8 continuation bytes are
// all >= 0x80, so they can never look like one) while the text between them
// goes through a streaming decoder — building the string byte-by-byte would
// turn a multi-byte password like "pässword" into mojibake that then fails
// hub auth despite being typed correctly.
function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const decoder = new TextDecoder();
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      let start = 0;
      const takeText = (end: number) => {
        if (end > start) buffer += decoder.decode(chunk.subarray(start, end), { stream: true });
        start = end + 1;
      };
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (byte === 0x0d || byte === 0x0a) { // Enter
          takeText(i);
          finish();
          resolve(buffer);
          return;
        }
        if (byte === 0x03) { // Ctrl-C: raw mode swallows the signal, so honor it here
          finish();
          reject(new CliError('cancelled'));
          return;
        }
        if (byte === 0x08 || byte === 0x7f) { // Backspace: drop one code point
          takeText(i);
          buffer = [...buffer].slice(0, -1).join('');
        } else if (byte < 0x20) { // other control keys: ignore
          takeText(i);
        }
      }
      takeText(chunk.length);
    };
    process.stdin.on('data', onData);
  });
}
