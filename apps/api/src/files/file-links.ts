import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a signed link gives access to: one PDF of the compile-output bucket, until `expires`. */
export interface FileLink {
  key: string;
  /** Unix time in seconds. */
  expires: number;
  /** `attachment` makes the browser save the file instead of showing it. */
  download: boolean;
}

const encode = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Signing key of file links, derived from AUTH_SECRET for this purpose only. */
export function fileLinkKey(authSecret: string): Buffer {
  return createHmac('sha256', authSecret).update('integris:file-link:v1').digest();
}

function signature(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** Token of a signed link: base64url(JSON) "." HMAC. It carries no user data. */
export function signFileLink(key: Buffer, link: FileLink): string {
  const payload = encode(
    JSON.stringify({ k: link.key, e: link.expires, d: link.download ? 1 : 0 }),
  );
  return `${payload}.${signature(key, payload)}`;
}

/** The link of a token, or null when it is forged, malformed or expired. */
export function verifyFileLink(key: Buffer, token: string, now = Date.now()): FileLink | null {
  const [payload, sent, extra] = token.split('.');
  if (!payload || !sent || extra !== undefined || payload.length > 2048) return null;
  const expected = Buffer.from(signature(key, payload));
  const given = Buffer.from(sent);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { k, e, d } = (data ?? {}) as { k?: unknown; e?: unknown; d?: unknown };
  if (typeof k !== 'string' || typeof e !== 'number' || (d !== 0 && d !== 1)) return null;
  if (e * 1000 <= now) return null;
  return { key: k, expires: e, download: d === 1 };
}

/** File name offered for a download: ASCII letters, digits, dashes and underscores only. */
export function downloadName(projectName: string): string {
  const base = projectName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'document'}.pdf`;
}

/**
 * A link of the files domain to an exam subject (docs/spec.md, "Devoirs et secrétariat"): the
 * watermarked preview of one reader (`preview`), or the clean print file through a one-time
 * link (`print`, `linkId` of a PrintDownloadLink row). Signed with its own key: a link to a
 * compiled PDF can never be turned into one to a subject.
 */
export interface ExamLink {
  kind: 'preview' | 'print';
  requestId: string;
  userId: string;
  /**
   * PrintDownloadLink of a print link; for a preview, the opening it belongs to (random, not
   * stored): every fetch of one preview link is the same opening, journaled once.
   */
  linkId: string | null;
  /** Unix time in seconds: when the preview was opened (shown in the watermark). */
  issued: number;
  /** Unix time in seconds. */
  expires: number;
}

export function examLinkKey(authSecret: string): Buffer {
  return createHmac('sha256', authSecret).update('integris:exam-link:v1').digest();
}

export function signExamLink(key: Buffer, link: ExamLink): string {
  const payload = encode(
    JSON.stringify({
      k: link.kind === 'preview' ? 'p' : 'd',
      r: link.requestId,
      u: link.userId,
      l: link.linkId,
      i: link.issued,
      e: link.expires,
    }),
  );
  return `${payload}.${signature(key, payload)}`;
}

/** The exam link of a token, or null when it is forged, malformed or expired. */
export function verifyExamLink(key: Buffer, token: string, now = Date.now()): ExamLink | null {
  const [payload, sent, extra] = token.split('.');
  if (!payload || !sent || extra !== undefined || payload.length > 1024) return null;
  const expected = Buffer.from(signature(key, payload));
  const given = Buffer.from(sent);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { k, r, u, l, i, e } = (data ?? {}) as Record<string, unknown>;
  if ((k !== 'p' && k !== 'd') || typeof r !== 'string' || typeof u !== 'string') return null;
  if (typeof i !== 'number' || typeof e !== 'number') return null;
  if (typeof l !== 'string' || !l) return null;
  if (e * 1000 <= now) return null;
  return {
    kind: k === 'p' ? 'preview' : 'print',
    requestId: r,
    userId: u,
    linkId: l,
    issued: i,
    expires: e,
  };
}
