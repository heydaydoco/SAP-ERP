'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { isAuthed } from '@/lib/auth';

type Company = { id: string; code: string; name: string };
type Row = { glAccount: string; currency: string; debit: string; credit: string; balance: string };

/** Trial balance — per (account, currency) debit/credit/balance. Confirms the JE hit the GL. */
export default function TrialBalancePage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyCodeId, setCompanyCodeId] = useState('');
  const [fiscalYear, setFiscalYear] = useState(2026);
  const [periodNo, setPeriodNo] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthed()) {
      router.push('/login');
      return;
    }
    void (async () => {
      const co = await api.GET('/org/company-codes', { params: { query: { pageSize: 200 } } });
      const cos = co.data?.data ?? [];
      setCompanies(cos);
      if (cos[0]) setCompanyCodeId(cos[0].id);
    })();
  }, [router]);

  async function load(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRows(null);
    const res = await api.GET('/finance-accounting/trial-balance', {
      params: {
        query: {
          companyCodeId,
          fiscalYear,
          ...(periodNo ? { periodNo: Number(periodNo) } : {}),
        },
      },
    });
    setBusy(false);
    if (res.error || !res.data) {
      setError('Failed to load trial balance.');
      return;
    }
    setRows(res.data);
  }

  const totals = (rows ?? []).reduce(
    (t, r) => ({ debit: t.debit + Number(r.debit), credit: t.credit + Number(r.credit) }),
    { debit: 0, credit: 0 },
  );

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Trial balance</h1>
      <form onSubmit={load} style={{ display: 'flex', gap: '1rem', alignItems: 'end', flexWrap: 'wrap' }}>
        <label>
          Company{' '}
          <select value={companyCodeId} onChange={(e) => setCompanyCodeId(e.target.value)}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fiscal year{' '}
          <input
            type="number"
            value={fiscalYear}
            onChange={(e) => setFiscalYear(Number(e.target.value))}
            style={{ width: 90 }}
          />
        </label>
        <label>
          Period (1–12, optional){' '}
          <input value={periodNo} onChange={(e) => setPeriodNo(e.target.value)} style={{ width: 60 }} />
        </label>
        <button type="submit" disabled={busy || !companyCodeId}>
          {busy ? 'Loading…' : 'Load'}
        </button>
      </form>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {rows && (
        <table style={{ borderCollapse: 'collapse', marginTop: '1rem' }}>
          <thead>
            <tr>
              {['Account', 'Currency', 'Debit', 'Credit', 'Balance'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.glAccount}:${r.currency}`}>
                <td style={td}>{r.glAccount}</td>
                <td style={td}>{r.currency}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.debit}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.credit}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.balance}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={td} colSpan={2}>
                <strong>Σ</strong>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>
                <strong>{totals.debit}</strong>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>
                <strong>{totals.credit}</strong>
              </td>
              <td style={td} />
            </tr>
          </tfoot>
        </table>
      )}
      {rows && rows.length === 0 && <p>No postings for that period.</p>}
    </main>
  );
}

const th: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 10px' };
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '4px 10px' };
