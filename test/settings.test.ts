import { afterEach, describe, expect, test } from 'bun:test';

import { CliError } from '../lib/errors';
import { isWindows, parseHubCli, passwordProblem, resolveHubPasswords } from '../lib/settings';

describe('parseHubCli', () => {
  test('no arguments means no overrides', () => {
    expect(parseHubCli([])).toEqual({});
  });

  test('parses every flag', () => {
    expect(parseHubCli(['--port', '9090', '--host', '0.0.0.0', '--data', 'D:\\hub-data']))
      .toEqual({ port: 9090, host: '0.0.0.0', data: 'D:\\hub-data' });
  });

  test('rejects an unknown argument', () => {
    expect(() => parseHubCli(['--bogus'])).toThrow(CliError);
    expect(() => parseHubCli(['serve'])).toThrow(CliError);
  });

  test('rejects a flag without its value', () => {
    expect(() => parseHubCli(['--data'])).toThrow(CliError);
  });

  test('rejects a port that is not a real port', () => {
    for (const port of ['0', '65536', 'http', '80.5']) {
      expect(() => parseHubCli(['--port', port])).toThrow(CliError);
    }
  });
});

describe('passwordProblem', () => {
  test('rejects the .env.example placeholder', () => {
    expect(passwordProblem('change-me-long-random')).toContain('placeholder');
  });

  test('rejects a short password', () => {
    expect(passwordProblem('short')).toContain('too short');
  });

  test('accepts a long random one', () => {
    expect(passwordProblem('definitely-long-enough-and-random')).toBeNull();
  });
});

describe('resolveHubPasswords', () => {
  const saved = {
    webaccess: process.env.PROMPTPORTAL_WEBACCESS_PASSWORD,
    workstation: process.env.PROMPTPORTAL_WORKSTATION_PASSWORD,
  };
  afterEach(() => {
    if (saved.webaccess === undefined) delete process.env.PROMPTPORTAL_WEBACCESS_PASSWORD;
    else process.env.PROMPTPORTAL_WEBACCESS_PASSWORD = saved.webaccess;
    if (saved.workstation === undefined) delete process.env.PROMPTPORTAL_WORKSTATION_PASSWORD;
    else process.env.PROMPTPORTAL_WORKSTATION_PASSWORD = saved.workstation;
  });

  test('takes both passwords from the environment', () => {
    process.env.PROMPTPORTAL_WEBACCESS_PASSWORD = 'web-password-long-enough';
    process.env.PROMPTPORTAL_WORKSTATION_PASSWORD = 'node-password-long-enough';
    expect(resolveHubPasswords()).toEqual({
      webaccess: 'web-password-long-enough',
      workstation: 'node-password-long-enough',
      problems: [],
    });
  });

  test('reports every problem at once, naming the variable', () => {
    process.env.PROMPTPORTAL_WEBACCESS_PASSWORD = 'change-me-long-random';
    process.env.PROMPTPORTAL_WORKSTATION_PASSWORD = 'short';
    const { problems } = resolveHubPasswords();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('PROMPTPORTAL_WEBACCESS_PASSWORD');
    expect(problems[1]).toContain('PROMPTPORTAL_WORKSTATION_PASSWORD');
  });

  // On Windows a missing variable falls back to Credential Manager, so this
  // only pins the message on platforms where the environment is the sole
  // source (the store's content on a dev machine is not the test's business).
  test.skipIf(isWindows)('a missing variable is a problem, not a throw', () => {
    delete process.env.PROMPTPORTAL_WEBACCESS_PASSWORD;
    delete process.env.PROMPTPORTAL_WORKSTATION_PASSWORD;
    const { problems } = resolveHubPasswords();
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Missing PROMPTPORTAL_WEBACCESS_PASSWORD');
  });
});
