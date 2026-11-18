import { createHash, createHmac } from 'node:crypto';

/** Keyed hash of an identifier (phone, e-mail, IP) so Redis never stores them in clear. */
export const keyedHash = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

/** Plain SHA-256, for high-entropy random tokens and session ids. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/**
 * Rate-limit bucket of a client address: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 reduced
 * to its /64 prefix, since one subscriber usually holds a whole /64.
 */
export function ipBucket(ip: string): string {
  const address = ip.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
