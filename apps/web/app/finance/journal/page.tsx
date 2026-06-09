'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { isAuthed } from '@/lib/auth';

type Row = {
  id: string;
  docNo: string;
  docType: string;
  postingDate: string;
  currency: string;
  status: string;
  reference: string;
};

/** Posted journals — confirm what landed in the GL. */
export default function JournalListPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthed()) {
      router.push('/login');
      return;
    }
    void (async () => {
      const res = await api.GET('/finance-accounting/journal-entries', {
        params: { query: { pageSize: 100 } },
      });
      setRows(res.data?.data ?? []);
      setLoading(false);
    })();
  }, [router]);

  return (
    <main style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Journals</h1>
      {loading ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No journals yet. <Link href="/finance/journal/new">Post one →</Link></p>
      ) : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Doc no', 'Type', 'Posting date', 'Currency', 'Status', 'Reference'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}>
                  <Link href={`/finance/journal/${r.id}`}>{r.docNo}</Link>
                </td>
                <td style={td}>{r.docType}</td>
                <td style={td}>{r.postingDate}</td>
                <td style={td}>{r.currency}</td>
                <td style={td}>{r.status}</td>
                <td style={td}>{r.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const th: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 10px' };
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '4px 10px' };
