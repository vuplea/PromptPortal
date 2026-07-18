import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import { Auth } from '../lib/auth';

const PASSWORD = 'correct horse battery staple'; // web access (Basic auth)
const WORKSTATION_PASSWORD = 'a different workstation secret'; // /session and /launcher

function basic(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const GOOD = basic('promptportal', PASSWORD);
const BAD = basic('promptportal', 'wrong');

afterEach(() => setSystemTime());

describe('credentials', () => {
  test('accepts the right username and password', () => {
    expect(new Auth(PASSWORD, WORKSTATION_PASSWORD).check(GOOD, '1.2.3.4')).toEqual({ ok: true });
  });

  test('rejects wrong password, wrong username, and malformed headers', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    expect(auth.check(BAD, '1.2.3.4')).toEqual({ ok: false, status: 401 });
    expect(auth.check(basic('admin', PASSWORD), '1.2.3.4')).toEqual({ ok: false, status: 401 });
    expect(auth.check('Bearer xyz', '1.2.3.4')).toEqual({ ok: false, status: 401 });
    expect(auth.check('Basic !!!not-base64-colon!!!', '1.2.3.4')).toEqual({ ok: false, status: 401 });
    expect(auth.check(undefined, '1.2.3.4')).toEqual({ ok: false, status: 401 });
  });

  test('accepts the bare workstation password on the workstation gate', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    expect(auth.checkPassword(Buffer.from(WORKSTATION_PASSWORD), '1.2.3.4')).toEqual({ ok: true });
    expect(auth.checkPassword(Buffer.from('wrong'), '1.2.3.4')).toEqual({ ok: false, status: 401 });
  });

  test('the passwords do not cross channels', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    expect(auth.checkPassword(Buffer.from(PASSWORD), '1.2.3.4')).toEqual({ ok: false, status: 401 });
    expect(auth.check(basic('promptportal', WORKSTATION_PASSWORD), '1.2.3.4')).toEqual({ ok: false, status: 401 });
  });
});

describe('lockout', () => {
  test('locks after free attempts are spent, then backs off exponentially', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 5; i++) {
      expect(auth.check(BAD, '9.9.9.9')).toEqual({ ok: false, status: 401 });
    }
    // The fifth failure armed a 30s lock that now gates even the right password.
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: false, status: 429, retryAfter: 30 });

    setSystemTime(new Date('2026-01-01T00:00:31Z'));
    expect(auth.check(BAD, '9.9.9.9')).toEqual({ ok: false, status: 401 }); // gate reopened; 6th failure
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: false, status: 429, retryAfter: 60 }); // doubled
  });

  test('a successful login clears the failure record', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 4; i++) auth.check(BAD, '9.9.9.9');
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: true });
    // A full set of free attempts is available again.
    for (let i = 0; i < 4; i++) expect(auth.check(BAD, '9.9.9.9')).toEqual({ ok: false, status: 401 });
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: true });
  });

  test('browser and workstation lockouts are tracked separately', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 5; i++) auth.checkPassword(Buffer.from('wrong'), '9.9.9.9');
    expect(auth.checkPassword(Buffer.from(WORKSTATION_PASSWORD), '9.9.9.9')).toEqual({ ok: false, status: 429, retryAfter: 30 });
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: true });
  });

  test('requests without credentials never accumulate failures', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 20; i++) expect(auth.check(undefined, '9.9.9.9')).toEqual({ ok: false, status: 401 });
    expect(auth.check(GOOD, '9.9.9.9')).toEqual({ ok: true });
  });

  test('an empty workstation password never accumulates failures', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 20; i++) {
      expect(auth.checkPassword(Buffer.alloc(0), '9.9.9.9')).toEqual({ ok: false, status: 401 });
    }
    expect(auth.checkPassword(Buffer.from(WORKSTATION_PASSWORD), '9.9.9.9')).toEqual({ ok: true });
  });
});

describe('lockout buckets', () => {
  test('IPv6 addresses fold to their /64', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 5; i++) auth.check(BAD, `2001:db8::${i + 1}`);
    // Same /64, different address: already locked.
    expect(auth.check(GOOD, '2001:db8::ffff')).toMatchObject({ ok: false, status: 429 });
    // Neighboring /64: unaffected.
    expect(auth.check(GOOD, '2001:db8:0:1::1')).toEqual({ ok: true });
  });

  test('IPv4-mapped IPv6 shares the plain IPv4 bucket', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 3; i++) auth.check(BAD, '1.2.3.4');
    for (let i = 0; i < 2; i++) auth.check(BAD, '::ffff:1.2.3.4');
    expect(auth.check(GOOD, '1.2.3.4')).toMatchObject({ ok: false, status: 429 });
  });

  test('zone ids are ignored', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    for (let i = 0; i < 5; i++) auth.check(BAD, 'fe80::1%eth0');
    expect(auth.check(GOOD, 'fe80::2%wlan0')).toMatchObject({ ok: false, status: 429 });
  });
});

describe('tokens', () => {
  test('are single-use', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    const token = auth.issueToken();
    expect(auth.consumeToken(token)).toBe(true);
    expect(auth.consumeToken(token)).toBe(false);
  });

  test('expire', () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    const token = auth.issueToken();
    setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(auth.consumeToken(token)).toBe(false);
  });

  test('unknown or missing tokens are rejected', () => {
    const auth = new Auth(PASSWORD, WORKSTATION_PASSWORD);
    expect(auth.consumeToken(undefined)).toBe(false);
    expect(auth.consumeToken('not-a-token')).toBe(false);
  });
});
