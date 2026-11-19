/** Fixed local ports on latex-dev (see CLAUDE.md). Nginx proxies to these; do not change them. */
export const PORTS = {
  web: 3000,
  api: 4000,
  collab: 1234,
  // Files domain (signed PDF links), served by the API process on its own port so that no app
  // route is reachable from that domain and no file route from the app domain.
  files: 4100,
} as const;

/** Path prefix kept by Nginx when proxying to the API. */
export const API_PREFIX = 'api';

/** WebSocket path kept by Nginx when proxying to the collaboration server. */
export const COLLAB_PATH = '/collab';
