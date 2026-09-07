import {describe, expect, it} from 'vitest';
import {canApplyWorkspaceResult} from '../apps/web/async-state.js';

describe('workspace-scoped async results', () => {
  it('rejects results after unmount, workspace changes, or a newer refresh starts', () => {
    expect(canApplyWorkspaceResult(7, 7, true, 3, 3)).toBe(true);
    expect(canApplyWorkspaceResult(7, 8, true, 3, 3)).toBe(false);
    expect(canApplyWorkspaceResult(7, 7, false, 3, 3)).toBe(false);
    expect(canApplyWorkspaceResult(7, 7, true, 3, 4)).toBe(false);
  });
});
