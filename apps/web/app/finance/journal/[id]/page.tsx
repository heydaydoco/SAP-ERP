'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { isAuthed } from '@/lib/auth';

type Line = {
  lineNo: number;
  glAccount: string;
  drCr: string;
  amount: string;
  currency: string;
  functionalAmount: string;
  functionalCurrency: string;
};
type Detail = {
  docNo: string;
  docType: string;
  status: string;
  postingDate: string;
  currency: string;
  functionalCurrency: string;
  fxRate: string | null;
  reference: string;
  lines: Line[];
};

/** A single posted journal: header + lines (confirm the Dr/Cr that hit the GL). */
export default function JournalDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [entry, setEntry] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthed()) {
      router.push('/login');
      return;
    }
    if (!id) return;
    void (async () => {
      const res = await api.GET('/finance-accounting/journal-entries/{id}', {
        params: { path: { id } },
      });
      if (res.error || !res.data) {
        setError('Not found.');
        return;
      }
      setEntry(res.data as Detail);
    })();
  }, [id, router]);

  if (error) return <main style={main}><p>{error}</p><Link href="/finance/journal">← Journals</Link></main>;
  if (!entry) return <main style={main}><p>Loading…</p></main>;

  return (
    <main style={main}>
      <p>
        <Link href="/finance/journal">← Journals</Link>
      </p>
      <h1>{entry.docNo}</h1>
      <p style={{ fontSize: 14 }}>
        {entry.docType} · {entry.status} · {entry.postingDate} · {entry.currency}
        {entry.fxRate ? ` · rate ${entry.fxRate} → ${entry.functionalCurrency}` : ''} · ref{' '}
        {entry.reference}
      </p>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['#', 'Account', 'Dr/Cr', `Amount`, `Functional (${entry.functionalCurrency})`].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l) => (
            <tr key={l.lineNo}>
              <td style={td}>{l.lineNo}</td>
              <td style={td}>{l.glAccount}</td>
              <td style={td}>{l.drCr}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                {l.amount} {l.currency}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{l.functionalAmount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const main: React.CSSProperties = { padding: '1.5rem', fontFamily: 'system-ui, sans-serif' };
const th: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 10px' };
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '4px 10px' };
