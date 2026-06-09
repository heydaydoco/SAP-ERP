# Security follow-ups

Tracked security work that is deliberately deferred. Each item names the dev-time shortcut, the
production requirement, and where the shortcut lives so it cannot silently ship.

## Web auth: move token storage from localStorage → httpOnly cookie  🔴 before production

- **Introduced by:** the web FI-verification slice (`claude/web-fi-journal`) — first `apps/web` ↔
  `apps/api` wiring.
- **Dev shortcut:** access + refresh JWTs are stored in `localStorage` (`apps/web/lib/auth.ts`) so the
  client can attach a `Bearer` token. This is XSS-exposed (any injected script can read the token).
- **Production requirement:** the server issues the **refresh token as an httpOnly + Secure +
  SameSite cookie** (never readable by JS); the **access token is held only in memory** and refreshed
  via the cookie. Remove the `localStorage` paths in `apps/web/lib/auth.ts`. Revisit CORS
  (`apps/api/src/main.ts`) to allow credentialed requests from the web origin only.
- **Blocks production deploy** (root CLAUDE.md §5.3 — PIPA / auth hardening; Phase 12).
