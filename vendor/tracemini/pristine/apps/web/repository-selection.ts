export type RepositoryCandidate = {
  id: number;
  agent_id: number;
  owner_user_id?: number;
  owner_name?: string;
  machine_name: string;
  local_key?: string;
  name: string;
  normalized_remote: string;
  branch?: string;
  traced: boolean;
  desired_traced: boolean;
  last_seen: string;
  error?: string;
};

export function repositorySelectionState(candidate: RepositoryCandidate) {
  if (candidate.error && candidate.desired_traced !== candidate.traced) {
    return {
      label: candidate.desired_traced ? 'Could not start tracing' : 'Could not stop tracing',
      pending: false,
      checked: candidate.desired_traced,
      tone: 'error',
    } as const;
  }
  if (candidate.desired_traced !== candidate.traced) {
    return {
      label: candidate.desired_traced ? 'Starting trace on device…' : 'Stopping trace on device…',
      detail: candidate.desired_traced
        ? 'Validating the repository and installing Git hooks. This can take up to a minute.'
        : 'Removing TraceMini hooks and updating the local device.',
      pending: true,
      checked: candidate.desired_traced,
      tone: 'progress',
    } as const;
  }
  return candidate.traced
    ? {label: 'Traced', detail: undefined, pending: false, checked: true, tone: 'success'} as const
    : {label: 'Available', detail: undefined, pending: false, checked: false, tone: 'muted'} as const;
}
