import {describe, expect, it} from 'vitest';
import {reportJobProgress} from '../apps/web/report-progress.js';

describe('report generation progress', () => {
  it('keeps an indeterminate progress indicator visible while a report is queued or running', () => {
    expect(reportJobProgress({status: 'pending'})).toEqual({active: true, tone: 'progress', label: 'Waiting for a connected device…'});
    expect(reportJobProgress({status: 'running'})).toEqual({active: true, tone: 'progress', label: 'Generating report on your device…'});
  });

  it('shows a durable terminal outcome when generation completes or fails', () => {
    expect(reportJobProgress({status: 'completed'})).toEqual({active: false, tone: 'success', label: 'Report completed.'});
    expect(reportJobProgress({status: 'failed', error: '/private/work/project failed'})).toEqual({active: false, tone: 'error', label: 'Report generation failed. Try again or check the device status.'});
  });
});
