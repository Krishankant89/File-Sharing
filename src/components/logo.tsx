import { cn } from "@/lib/cn";

export function Logo({ onDark = false, className }: { onDark?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-xl font-extrabold tracking-tight",
        onDark ? "text-paper" : "text-navy",
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="h-8 w-8 shrink-0" aria-hidden="true">
        {!onDark ? <rect width="16" height="16" rx="3.5" className="fill-navy" /> : null}
        <path className="fill-blue" d="M8 8.2 14 14.2H11.2L8 11 4.8 14.2H2Z" />
        <path className="fill-sand" d="M8 2.2 13 7.2H10.6L8 4.6 5.4 7.2H3Z" />
      </svg>
      Peakline
    </span>
  );
}
