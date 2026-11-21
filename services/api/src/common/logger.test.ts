import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/capture.js';
import { buildLogger } from './logger.js';

const PERSONAL = [
  'riya.s@gmail.com',
  'ya29.a0AfH6SMB-secret-token',
  'Dear Acme, please erase my records',
  'ABCDE1234F',
  '9876543210',
];

describe('buildLogger', () => {
  it('emits JSON with a service name and ISO time', () => {
    const cap = captureLogs();
    buildLogger({ level: 'info', stream: cap.stream }).info({ statusCode: 200 }, 'hello');
    const [line] = cap.lines();
    expect(line).toMatchObject({ service: 'api', msg: 'hello', statusCode: 200 });
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps personal data out of objects, messages and errors', () => {
    const cap = captureLogs();
    const log = buildLogger({ level: 'info', stream: cap.stream });

    log.info({ email: PERSONAL[0], draftBody: PERSONAL[2], nested: { note: `token ${PERSONAL[1]}` } }, `user ${PERSONAL[0]} signed in`);
    log.warn({ err: new Error(`failed for ${PERSONAL[0]} id ${PERSONAL[3]}`) }, 'with err key');
    log.error(new Error(`bare error ${PERSONAL[4]}`));
    log.info(`plain message ${PERSONAL[0]} ${PERSONAL[1]}`);

    const out = cap.text();
    for (const p of PERSONAL) expect(out).not.toContain(p);
    expect(out).toContain('bare error [number]');
  });

  it('respects the configured level', () => {
    const cap = captureLogs();
    const log = buildLogger({ level: 'warn', stream: cap.stream });
    log.info('quiet');
    log.warn('loud');
    expect(cap.lines().map((l) => l.msg)).toEqual(['loud']);
  });
});
