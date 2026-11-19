import type { CompileJob } from '@integris/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadSources, SourcesError } from './sources.js';

describe('downloadSources', () => {
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: 'http://169.254.169.254/' }).end();
      } else if (request.url === '/expired') {
        response.writeHead(403).end();
      } else {
        response.writeHead(200).end(request.url === '/big' ? 'x'.repeat(50) : 'hello');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const job = (files: CompileJob['files']): CompileJob => ({
    compilationId: 'c',
    projectId: 'p',
    engine: 'PDFLATEX',
    mainFile: 'main.tex',
    timeoutSeconds: 20,
    files,
  });
  const options = () => ({ minioOrigin: origin, maxTotalBytes: 1000 });
  const file = (path: string, url = '/main', size = 5) => ({ path, size, url: `${origin}${url}` });

  it('downloads every file with its exact size', async () => {
    const entries = await downloadSources(job([file('main.tex'), file('ch/a.tex')]), options());
    expect(entries.map((entry) => [entry.name, Buffer.from(entry.data).toString()])).toEqual([
      ['main.tex', 'hello'],
      ['ch/a.tex', 'hello'],
    ]);
  });

  it.each([
    ['../etc/passwd.tex'],
    ['/etc/passwd.tex'],
    ['latexmkrc'],
    ['.latexmkrc'],
    ['script.pl'],
    ['a/./b.tex'],
  ])('refuses the path %s', async (path) => {
    await expect(downloadSources(job([file(path)]), options())).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('refuses URLs outside the storage, redirects, and sizes that differ', async () => {
    const outside = { path: 'main.tex', size: 5, url: 'http://127.0.0.2:9/x' };
    await expect(downloadSources(job([outside]), options())).rejects.toBeInstanceOf(SourcesError);
    await expect(
      downloadSources(job([file('main.tex', '/redirect')]), options()),
    ).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(downloadSources(job([file('main.tex', '/big')]), options())).rejects.toMatchObject(
      {
        reason: 'invalid',
      },
    );
    await expect(
      downloadSources(job([file('main.tex', '/main', 9)]), options()),
    ).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('refuses duplicates and projects over the size budget', async () => {
    await expect(
      downloadSources(job([file('main.tex'), file('main.tex')]), options()),
    ).rejects.toMatchObject({ reason: 'invalid' });
    const big = { ...file('main.tex'), size: 2000 };
    await expect(downloadSources(job([big]), options())).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('reports an expired link as unavailable', async () => {
    await expect(
      downloadSources(job([file('main.tex', '/expired')]), options()),
    ).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
});
