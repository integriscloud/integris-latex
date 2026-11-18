/** Fixed local ports on latex-dev (see CLAUDE.md). Nginx proxies to these; do not change them. */
export const PORTS = {
  web: 3000,
  api: 4000,
  collab: 1234,
} as const;

/** Path prefix kept by Nginx when proxying to the API. */
export const API_PREFIX = 'api';

/** WebSocket path kept by Nginx when proxying to the collaboration server. */
export const COLLAB_PATH = '/collab';
