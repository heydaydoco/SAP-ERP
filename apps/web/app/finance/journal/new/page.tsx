'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { isAuthed } from '@/lib/auth';

type Company = { id: string; code: string; name: string };
type Currency = { code: string; name: string };
type Account = { accountNumber: string; name: string };
type Line = { glAccount: string; drCr: 'D' | 'C'; amount: string };

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = (): Line => ({ glAccount: '', drCr: 'D', amount: '' });

/** Manual GL journal entry: header + N debit/credit lines → post() → show the JE number. */
export default function NewJournalPage() {
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [companyCodeId, setCompanyCodeId] = useState('');
  const [currency, setCurrency] = useState('KRW');
  const [postingDate, setPostingDate] = useState(today());
  const [reference, setReference] = useState('manual');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ journalId: string; docNo: string; status: string } | null>(
    null,
  );

  useEffect(() => {
    if (!isAuthed()) {
      router.push('/login');
      return;
    }
    void (async () => {
      const [co, cur, acc] = await Promise.all([
        api.GET('/org/company-codes', { params: { query: { pageSize: 200 } } }),
        api.GET('/master-data/currencies', { params: { query: { pageSize: 200 } } }),
        api.GET('/master-data/gl-accounts', { params: { query: { pageSize: 200 } } }),
      ]);
      const cos = co.data?.data ?? [];
      setCompanies(cos);
      if (cos[0]) setCompanyCodeId(cos[0].id);
      setCurrencies(cur.data?.data ?? []);
      setAccounts(acc.data?.data ?? []);
    })();
  }, [router]);

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      const n = Number(l.amount) || 0;
      if (l.drCr === 'D') debit += n;
      else credit += n;
    }
    return { debit, credit, balanced: debit === credit && debit > 0 };
  }, [lines]);

  function setLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error } = await api.POST('/finance-accounting/journal-entries', {
      body: {
        companyCodeId,
        postingDate,
        currency,
        reference,
        lines: lines.map((l) => ({ glAccount: l.glAccount, drCr: l.drCr, amount: l.amount })),
      },
    });
    if (error || !data) {
      setBusy(false);
      setError(messageOf(error) ?? 'Posting failed.');
      return;
    }
    // Fetch the entry back to show its document number (the post() result carries only the id/status).
    const detail = await api.GET('/finance-accounting/journal-entries/{id}', {
      params: { path: { id: data.journalId } },
    });
    setBusy(false);
    setResult({
      journalId: data.journalId,
      docNo: detail.data?.docNo ?? '(see Journals)',
      status: data.status,
    });
  }

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif', maxWidth: 820 }}>
      <h1>New manual journal</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <label>
            Company code{' '}
            <select value={companyCodeId} onChange={(e) => setCompanyCodeId(e.target.value)}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Currency{' '}
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Posting date{' '}
            <input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} />
          </label>
          <label>
            Reference{' '}
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        </div>

        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={th}>GL account</th>
              <th style={th}>Dr/Cr</th>
              <th style={th}>Amount ({currency})</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td style={td}>
                  <select value={l.glAccount} onChange={(e) => setLine(i, { glAccount: e.target.value })}>
                    <option value="">— select —</option>
                    {accounts.map((a) => (
                      <option key={a.accountNumber} value={a.accountNumber}>
                        {a.accountNumber} — {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={td}>
                  <select
                    value={l.drCr}
                    onChange={(e) => setLine(i, { drCr: e.target.value as 'D' | 'C' })}
                  >
                    <option value="D">Debit</option>
                    <option value="C">Credit</option>
                  </select>
                </td>
                <td style={td}>
                  <input
                    value={l.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </td>
                <td style={td}>
                  {lines.length > 2 && (
                    <button type="button" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div>
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            + Add line
          </button>
        </div>

        <p style={{ fontSize: 14 }}>
          Debit <strong>{totals.debit}</strong> · Credit <strong>{totals.credit}</strong> —{' '}
          <span style={{ color: totals.balanced ? 'green' : 'crimson' }}>
            {totals.balanced ? 'balanced' : 'not balanced'}
          </span>{' '}
          <span style={{ color: '#888' }}>(the server is authoritative; it rejects an unbalanced entry)</span>
        </p>

        <div>
          <button type="submit" disabled={busy || !companyCodeId}>
            {busy ? 'Posting…' : 'Post'}
          </button>
        </div>

        {error && <p style={{ color: 'crimson' }}>{error}</p>}
        {result && (
          <p style={{ color: 'green' }}>
            Posted <strong>{result.docNo}</strong> ({result.status}) —{' '}
            <Link href={`/finance/journal/${result.journalId}`}>view entry</Link>
          </p>
        )}
      </form>
    </main>
  );
}

const th: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #ccc', padding: 4 };
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: 4 };

function messageOf(err: unknown): string | null {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.join(', ');
  }
  return null;
}
