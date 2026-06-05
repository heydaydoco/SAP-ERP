import { describe, expect, it } from 'vitest';
import { trialBalance } from './trial-balance.js';

describe('trialBalance', () => {
  it('aggregates debit/credit per (account, currency) and computes the signed balance', () => {
    const rows = trialBalance([
      { glAccount: '1000', currency: 'KRW', drCr: 'D', amount: '300000.0000' },
      { glAccount: '1000', currency: 'KRW', drCr: 'C', amount: '50000.0000' },
      { glAccount: '4000', currency: 'KRW', drCr: 'C', amount: '300000.0000' },
      { glAccount: '6100', currency: 'KRW', drCr: 'D', amount: '50000.0000' },
    ]);
    expect(rows).toEqual([
      {
        glAccount: '1000',
        currency: 'KRW',
        debit: '300000.0000',
        credit: '50000.0000',
        balance: '250000.0000',
      },
      {
        glAccount: '4000',
        currency: 'KRW',
        debit: '0.0000',
        credit: '300000.0000',
        balance: '-300000.0000',
      },
      {
        glAccount: '6100',
        currency: 'KRW',
        debit: '50000.0000',
        credit: '0.0000',
        balance: '50000.0000',
      },
    ]);
  });

  it('keeps currencies apart on the same account', () => {
    const rows = trialBalance([
      { glAccount: '1000', currency: 'KRW', drCr: 'D', amount: '1000.0000' },
      { glAccount: '1000', currency: 'USD', drCr: 'D', amount: '1.5000' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ currency: 'KRW', debit: '1000.0000' });
    expect(rows[1]).toMatchObject({ currency: 'USD', debit: '1.5000' });
  });

  it('sums exactly at fixed scale (no float drift)', () => {
    const rows = trialBalance([
      { glAccount: '1000', currency: 'USD', drCr: 'D', amount: '0.1000' },
      { glAccount: '1000', currency: 'USD', drCr: 'D', amount: '0.2000' },
    ]);
    expect(rows[0]?.debit).toBe('0.3000');
  });

  it('a balanced journal yields equal total debits and credits', () => {
    const rows = trialBalance([
      { glAccount: '1000', currency: 'KRW', drCr: 'D', amount: '99999.0000' },
      { glAccount: '4000', currency: 'KRW', drCr: 'C', amount: '99999.0000' },
    ]);
    const debit = rows.reduce((sum, r) => sum + Number(r.debit), 0);
    const credit = rows.reduce((sum, r) => sum + Number(r.credit), 0);
    expect(debit).toBe(credit);
  });

  it('rejects malformed NUMERIC strings', () => {
    expect(() =>
      trialBalance([{ glAccount: '1000', currency: 'KRW', drCr: 'D', amount: '1e5' }]),
    ).toThrow(/invalid NUMERIC/);
  });

  it('returns an empty array for no lines', () => {
    expect(trialBalance([])).toEqual([]);
  });
});
