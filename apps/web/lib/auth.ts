/**
 * ⚠️ DEV-ONLY token storage — DO NOT SHIP TO PRODUCTION.
 *
 * Access/refresh JWTs are kept in `localStorage` so the FI verification UI can attach a Bearer token
 * to api calls. This is a development convenience and is exposed to XSS (any script on the page can
 * read the token). BEFORE PRODUCTION this MUST be replaced by an httpOnly + Secure + SameSite refresh
 * cookie set by the server, with the access token held only in memory — the token must never be
 * readable by JavaScript. Tracked in docs/security-followups.md (item: web auth → httpOnly cookie).
 */
const ACCESS_KEY = 'erp.accessToken';
const REFRESH_KEY = 'erp.refreshToken';

export function setTokens(t: { accessToken: string; refreshToken: string }): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACCESS_KEY, t.accessToken);
  localStorage.setItem(REFRESH_KEY, t.refreshToken);
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACCESS_KEY);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function isAuthed(): boolean {
  return getAccessToken() !== null;
}
