'use client';

/**
 * Reads `#token=…` from the link sent by e-mail and removes it from the address bar. The token
 * travels in the fragment so it never reaches a server log or a Referer header.
 */
export function takeTokenFromHash(): string | null {
  // Read once per page: React runs effects twice in development.
  if (taken !== undefined) return taken;
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  taken = match?.[1] ?? null;
  return taken;
}

let taken: string | null | undefined;
