import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

describe('Vercel deployment configuration', () => {
  it('routes the site through the serverless Express entrypoint and bundles runtime assets', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const entrypoint = fs.readFileSync(path.join(root, 'api/index.ts'), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

    expect(entrypoint).toContain("import('../apps/server/src/vercel.js')");
    expect(config.buildCommand).toBe('npm run build');
    expect(config.outputDirectory).toBe('apps/web/dist');
    expect(config.regions).toEqual(['sin1']);
    expect(config.headers).toContainEqual({
      source: '/assets/(.*)',
      headers: [{key: 'Cache-Control', value: 'public, max-age=31536000, immutable'}],
    });
    expect(config.rewrites).toEqual([
      {source: '/api/(.*)', destination: '/api/index'},
      {source: '/((?!api/).*)', destination: '/index.html'},
    ]);
    expect(config.functions['api/index.ts'].includeFiles)
      .toBe('{apps/web/dist/**,packages/cli/dist/**,apps/server/certs/**}');
  });
});
