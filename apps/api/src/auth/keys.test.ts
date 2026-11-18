import { describe, expect, it } from 'vitest';
import { ipBucket } from './keys.js';

describe('ipBucket', () => {
  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    expect(ipBucket('10.0.0.1')).toBe('10.0.0.1');
    expect(ipBucket('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });

  it('reduces IPv6 to its /64 prefix', () => {
    expect(ipBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
  });
});
