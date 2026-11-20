'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * Inline script of the server HTML. React never runs a script it creates on the client and warns
 * about it ("Encountered a script tag…"), e.g. when the root layout renders again for another
 * language: the script is kept for the server HTML and the hydration (where it has already run),
 * and is not rendered by a client render.
 */
export function ServerOnlyScript({ html }: { html: string }) {
  const fromServer = useSyncExternalStore(
    subscribe,
    () => false,
    () => true,
  );
  return fromServer ? <script dangerouslySetInnerHTML={{ __html: html }} /> : null;
}
