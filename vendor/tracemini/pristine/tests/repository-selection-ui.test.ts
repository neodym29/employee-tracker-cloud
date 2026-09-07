import {describe, expect, it} from 'vitest';
import {repositorySelectionState} from '../apps/web/repository-selection.js';

describe('repository selection state', () => {
  it('distinguishes available, pending, traced, and failed repositories', () => {
    expect(repositorySelectionState({traced: false, desired_traced: false} as any)).toMatchObject({label: 'Available', pending: false, checked: false, tone: 'muted'});
    expect(repositorySelectionState({traced: false, desired_traced: true} as any)).toMatchObject({label: 'Starting trace on device…', pending: true, checked: true, tone: 'progress'});
    expect(repositorySelectionState({traced: true, desired_traced: false} as any)).toMatchObject({label: 'Stopping trace on device…', pending: true, checked: false, tone: 'progress'});
    expect(repositorySelectionState({traced: true, desired_traced: true} as any)).toMatchObject({label: 'Traced', pending: false, checked: true, tone: 'success'});
    expect(repositorySelectionState({traced: false, desired_traced: true, error: 'cannot install hook'} as any)).toEqual({label: 'Could not start tracing', pending: false, checked: true, tone: 'error'});
  });
});
