import { describe, expect, it } from 'vitest';
import { renderAccountBalances } from './account-balance-report.js';

describe('renderAccountBalances', () => {
  it('sorts balances from high to low and shows masked tokens', () => {
    const markdown = renderAccountBalances([
      account('low', 'abcdefgh…12345678', 50),
      account('high', 'ijklmnop…87654321', 140)
    ], new Date('2026-08-20T12:00:00.000Z'));

    expect(markdown.indexOf('high')).toBeLessThan(markdown.indexOf('low'));
    expect(markdown).toContain('abcdefgh…12345678');
    expect(markdown).toContain('ijklmnop…87654321');
    expect(markdown).not.toContain('_token=');
  });
});

function account(sessionId: string, tokenMasked: string, credits: number) {
  return {
    sessionId,
    adapterId: 'hailuo-v1',
    tokenMasked,
    busy: false,
    activeJobs: 0,
    capacity: 2,
    credits,
    creditsCheckedAt: '2026-08-20T11:59:00.000Z',
    depleted: false,
    exhausted: false
  };
}
