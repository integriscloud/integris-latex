import { describe, expect, it } from 'vitest';
import { collabUrl } from './project-collab';

const at = (url: string) => {
  const { protocol, host, hostname, port } = new URL(url);
  return { protocol, host, hostname, port };
};

describe('collabUrl', () => {
  it('uses the path proxied by Nginx on the app origin', () => {
    expect(collabUrl(at('https://latex.integriscloud.com/fr/app'))).toBe(
      'wss://latex.integriscloud.com/collab',
    );
    expect(collabUrl(at('http://localhost:8080/'))).toBe('ws://localhost:8080/collab');
  });

  it('reaches the collaboration port directly when the web port is opened without Nginx', () => {
    expect(collabUrl(at('http://127.0.0.1:3000/fr/app'))).toBe('ws://127.0.0.1:1234/collab');
  });
});
