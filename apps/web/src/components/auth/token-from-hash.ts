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

/**
 * Invitation carried to the sign-in and sign-up pages (`#invite=…` for a project, `#join=…` for
 * an organization), so it opens again once signed in: the path of its page with the token. Kept
 * in the fragment: never sent to a server.
 */
export function invitationReturnFromHash(): string | null {
  const match = /(?:^#|&)(invite|join)=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (!match) return null;
  return `${match[1] === 'join' ? '/join' : '/invite'}#token=${match[2]}`;
}

/** Token of the invitation page (`/invite#token=…`), left in the address for a reload. */
export function invitationTokenFromHash(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  return match?.[1] ?? null;
}
