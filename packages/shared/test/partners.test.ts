import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, nextAttemptAt, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_SECONDS, webhookUrlProblem } from '../src';

describe('webhook URLs', () => {
  it('https to a public host only; localhost only when allowed; no private or credentialed URLs', () => {
    expect(webhookUrlProblem('https://partner.example.com/hook', false)).toBeNull();
    expect(webhookUrlProblem('http://partner.example.com/hook', false)).toMatch(/https/);
    expect(webhookUrlProblem('http://localhost:3000/x', false)).toMatch(/development/);
    expect(webhookUrlProblem('http://localhost:3000/x', true)).toBeNull();
    for (const host of ['10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '127.0.0.2', 'db.internal', '[fd00::1]']) {
      expect(webhookUrlProblem(`https://${host}/x`, true), host).not.toBeNull();
    }
    expect(webhookUrlProblem('https://172.32.0.1/x', false)).toBeNull(); // outside 172.16/12
    expect(webhookUrlProblem('https://a:b@partner.example.com/', false)).toMatch(/credentials/);
    expect(webhookUrlProblem('nope', false)).toBe('Not a URL');
  });
});

describe('retries', () => {
  it('follow the schedule, then give up', () => {
    const t0 = new Date('2026-09-26T12:00:00Z');
    expect(nextAttemptAt(1, t0)!.getTime() - t0.getTime()).toBe(WEBHOOK_RETRY_SECONDS[0] * 1000);
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS - 1, t0)).not.toBeNull();
    expect(nextAttemptAt(WEBHOOK_MAX_ATTEMPTS, t0)).toBeNull();
  });

  it('key format', () => {
    expect(API_KEY_PATTERN.test(`adp_abcd1234_${'x'.repeat(43)}`)).toBe(true);
    expect(API_KEY_PATTERN.test('adp_ABCD1234_short')).toBe(false);
  });
});
