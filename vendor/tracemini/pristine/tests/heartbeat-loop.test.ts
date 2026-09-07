import {afterEach, describe, expect, it, vi} from 'vitest';
import {effectiveAgentPollMs, startHeartbeatLoop} from '../packages/cli/src/agent.js';

describe('independent agent heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('uses one low-frequency idle control sync even for older fast-poll configurations', () => {
    expect(effectiveAgentPollMs(2_000)).toBe(60_000);
    expect(effectiveAgentPollMs(600_000)).toBe(600_000);
  });

  it('continues sending heartbeats while other agent work is still running', async () => {
    vi.useFakeTimers();
    let heartbeats = 0;
    const stop = startHeartbeatLoop(async () => {
      heartbeats++;
    }, 100);

    await vi.advanceTimersByTimeAsync(350);
    stop();

    expect(heartbeats).toBe(3);
  });
});
