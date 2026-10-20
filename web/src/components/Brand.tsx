import { cn } from "../lib/format";

/** The Musike mark: four cue pads, the first holding a play glyph. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="7" y="7" width="15" height="15" rx="4.5" fill="currentColor" />
      <path d="M12.6 10.9 L19.4 14.5 L12.6 18.1 Z" fill="#0b0b0b" />
      <g fill="none" stroke="currentColor" strokeWidth="3.2">
        <rect x="26" y="7" width="15" height="15" rx="4.5" />
        <rect x="7" y="26" width="15" height="15" rx="4.5" />
        <rect x="26" y="26" width="15" height="15" rx="4.5" />
      </g>
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <LogoMark className="size-7 text-[#c3ec52]" />
      <span className="text-[17px] font-semibold tracking-tight">musike</span>
    </span>
  );
}

/** The mark in motion: marks the track that is playing. */
export function Equalizer({ live, className }: { live: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex h-3.5 items-end gap-[2px]", live && "eq-live", className)}>
      <span className="eq-bar h-full w-[3px] rounded-full bg-accent-text" />
      <span className="eq-bar h-full w-[3px] rounded-full bg-accent-text" />
      <span className="eq-bar h-full w-[3px] rounded-full bg-accent-text" />
    </span>
  );
}
