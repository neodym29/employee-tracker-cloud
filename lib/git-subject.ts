import { safeGitWorkText } from './tracemini-work-evidence';

export function humanizeCommitSubject(value: unknown) {
  const subject = safeGitWorkText(value, 300);
  if (!subject) return 'Recorded a repository change.';
  const conventional = subject.match(/^([a-z]+)(?:\([^)]+\))?!?:\s*(.+)$/i);
  if (!conventional) return `${subject.charAt(0).toUpperCase()}${subject.slice(1)}${/[.!?]$/.test(subject) ? '' : '.'}`;
  const body = conventional[2].trim().replace(/[.!?]+$/, '');
  const labels: Record<string, string> = {
    feat: 'Added', fix: 'Fixed', docs: 'Updated documentation', refactor: 'Improved',
    perf: 'Improved performance', test: 'Updated testing', style: 'Polished',
    build: 'Updated project setup', ci: 'Updated delivery setup', chore: 'Maintenance',
    revert: 'Reverted',
  };
  const label = labels[conventional[1].toLowerCase()] || 'Updated';
  return `${label}: ${body}.`;
}
