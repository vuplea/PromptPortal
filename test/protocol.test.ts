import { expect, test } from 'bun:test';

import { parse, send } from '../lib/protocol';

test('parse accepts a JSON object, as a string or a Buffer', () => {
  expect(parse('{"t":"i","d":"x"}')).toEqual({ t: 'i', d: 'x' });
  expect(parse(Buffer.from('{"t":"ping"}'))).toEqual({ t: 'ping' });
});

test('parse returns null for invalid JSON and non-objects', () => {
  expect(parse('nope{')).toBeNull();
  expect(parse('42')).toBeNull();
  expect(parse('"a string"')).toBeNull();
  expect(parse('null')).toBeNull();
  expect(parse('[1,2,3]')).toBeNull();
  expect(parse('')).toBeNull();
});

test('send writes JSON only to an open socket', () => {
  const sent: string[] = [];
  const sock = { readyState: 1, send: (data: string) => sent.push(data) };
  send(sock, { t: 'ping' });
  sock.readyState = 3;
  send(sock, { t: 'x', code: 0 });
  expect(sent).toEqual(['{"t":"ping"}']);
});
