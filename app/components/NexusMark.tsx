export default function NexusMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <circle className="nexusMarkOuter" cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="120 44" opacity=".62" />
    <circle className="nexusMarkInner" cx="32" cy="32" r="16" stroke="var(--accent, currentColor)" strokeWidth="2" strokeLinecap="round" strokeDasharray="72 29" />
    <circle cx="32" cy="32" r="3.5" fill="currentColor" />
  </svg>;
}
