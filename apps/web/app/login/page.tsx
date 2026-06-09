'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { setTokens } from '@/lib/auth';

/** Dev login — seed admin is `admin` / `admin123` (ADMIN role `*` covers every FI permission). */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await api.POST('/auth/login', { body: { username, password } });
    setBusy(false);
    if (error || !data) {
      setError('Login failed — check credentials and that the api is running on :4000.');
      return;
    }
    setTokens(data);
    router.push('/finance/journal/new');
  }

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 360 }}>
      <h1>Sign in</h1>
      <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem' }}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p style={{ color: 'crimson' }}>{error}</p>}
      </form>
    </main>
  );
}
