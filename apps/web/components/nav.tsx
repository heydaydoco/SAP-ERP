'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearTokens } from '@/lib/auth';

/** Minimal nav for the FI verification screens (styling intentionally minimal). */
export function Nav() {
  const router = useRouter();
  return (
    <nav
      style={{
        display: 'flex',
        gap: '1rem',
        alignItems: 'center',
        padding: '0.75rem 1rem',
        borderBottom: '1px solid #ccc',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
      }}
    >
      <strong>SAP-ERP · FI</strong>
      <Link href="/finance/journal/new">New journal</Link>
      <Link href="/finance/journal">Journals</Link>
      <Link href="/finance/trial-balance">Trial balance</Link>
      <button
        type="button"
        style={{ marginLeft: 'auto' }}
        onClick={() => {
          clearTokens();
          router.push('/login');
        }}
      >
        Log out
      </button>
    </nav>
  );
}
