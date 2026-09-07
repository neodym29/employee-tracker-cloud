import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('invitation notification styling', () => {
  it('marks pending invitation counts with the dedicated red notification style', () => {
    const source = fs.readFileSync(path.join(root, 'apps/web/src.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'apps/web/style.css'), 'utf8');
    expect(source).toContain('className="count-badge invitation-notification"');
    expect(css).toMatch(/\.invitation-notification\{[^}]*background:var\(--danger\)/);
    expect(css).toMatch(/html\[data-theme=night\] \.invitation-notification\{[^}]*background:#dc2626/);
  });
});
