export default function NexusMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
    <rect width="64" height="64" rx="16" fill="#211D35" />
    <path d="M17 45V19L47 45V19" stroke="#FAF9FF" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="17" cy="19" r="4" fill="#AB99FF" />
    <circle cx="47" cy="45" r="4" fill="#76E0D0" />
  </svg>;
}
