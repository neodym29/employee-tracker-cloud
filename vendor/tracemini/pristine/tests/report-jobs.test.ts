import {describe, expect, it, vi} from 'vitest';
import {waitForReportJob} from '../apps/web/report-jobs.js';

describe('bounded report job polling', () => {
  it('polls only the active job and stops when it completes', async () => {
    const statuses = [{status: 'pending'}, {status: 'running'}, {status: 'completed'}];
    const fetchStatus = vi.fn(async (jobId: number) => ({id: jobId, ...statuses.shift()!}));
    const wait = vi.fn(async () => undefined);
    const onStatus = vi.fn();

    const result = await waitForReportJob(18, fetchStatus, {intervalMs: 1, maxAttempts: 10, wait, onStatus});

    expect(result).toMatchObject({id: 18, status: 'completed'});
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(fetchStatus).toHaveBeenCalledWith(18);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(onStatus.mock.calls.map(([status]) => status.status)).toEqual(['pending', 'running', 'completed']);
  });

  it('returns the latest status after its bounded attempt limit', async () => {
    const fetchStatus = vi.fn(async () => ({id: 18, status: 'running'}));
    const result = await waitForReportJob(18, fetchStatus, {intervalMs: 1, maxAttempts: 2, wait: async () => undefined});
    expect(result?.status).toBe('running');
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('stops when its route or workspace scope is cancelled', async () => {
    let active = true;
    const fetchStatus = vi.fn(async () => {
      active = false;
      return {id: 18, status: 'running'};
    });
    const wait = vi.fn(async () => undefined);

    const result = await waitForReportJob(18, fetchStatus, {
      isActive: () => active,
      wait,
    });

    expect(result).toBeUndefined();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops on any status other than pending or running', async () => {
    const fetchStatus = vi.fn(async () => ({id: 18, status: 'cancelled'}));
    const result = await waitForReportJob(18, fetchStatus, {wait: async () => undefined});
    expect(result?.status).toBe('cancelled');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});
