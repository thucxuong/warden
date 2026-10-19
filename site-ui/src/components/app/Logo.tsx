export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <path className="fill-primary" d="M16 2.5 27.5 6.6v8.3c0 7-4.8 12.4-11.5 14.6C9.3 27.3 4.5 21.9 4.5 14.9V6.6z" />
      <path className="stroke-primary-foreground" d="m10.6 15.8 3.8 3.8 7.2-7.6" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
