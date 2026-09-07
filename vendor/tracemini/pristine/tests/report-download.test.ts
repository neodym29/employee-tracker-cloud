import {describe, expect, it} from 'vitest';
import {buildReportDownload} from '../apps/web/report-download.js';

describe('report downloads', () => {
  it('builds a portable Markdown attachment with a stable safe filename', () => {
    expect(buildReportDownload({
      id: 42,
      start_date: '2026-08-01',
      end_date: '2026-08-07',
      markdown: '# Weekly report\n\nCompleted work.',
    })).toEqual({
      filename: 'tracemini-report-2026-08-01-to-2026-08-07.md',
      contents: '# Weekly report\n\nCompleted work.\n',
      mimeType: 'text/markdown;charset=utf-8',
    });
  });

  it('uses a safe report name in the Markdown filename', () => {
    expect(buildReportDownload({
      id: 43,
      name: 'August Platform Delivery / Review',
      start_date: '2026-08-01',
      end_date: '2026-08-07',
      markdown: '# Named report',
    }).filename).toBe('tracemini-august-platform-delivery-review.md');
  });
});
