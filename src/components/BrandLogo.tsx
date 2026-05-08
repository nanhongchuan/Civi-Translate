export type BrandLogoVariant = "live" | "loop" | "caption" | "civi";

type Props = {
  size?: "sm" | "lg";
  variant?: BrandLogoVariant;
  className?: string;
};

const LOGO_SURFACE: Record<BrandLogoVariant, string> = {
  live: "bg-gradient-to-br from-[#06b6d4] via-[#2563eb] to-[#6d28d9] shadow-blue-500/25",
  loop: "bg-gradient-to-br from-[#0f766e] via-[#2563eb] to-[#4f46e5] shadow-sky-500/25",
  caption: "bg-gradient-to-br from-[#0284c7] via-[#4f46e5] to-[#7c3aed] shadow-violet-500/25",
  civi: "bg-gradient-to-br from-[#0f172a] via-[#1d4ed8] to-[#06b6d4] shadow-indigo-500/25",
};

function LiveGlyph() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" role="img">
      <circle cx="14.5" cy="16.5" r="3.8" fill="#bbf7d0" />
      <path
        d="M16 38V26M26 44V20M36 38V26"
        stroke="white"
        strokeWidth="5.6"
        strokeLinecap="round"
      />
      <path
        d="M42 32h13"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M50 25l7 7-7 7"
        stroke="white"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoopGlyph() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" role="img">
      <path
        d="M46 19a19 19 0 0 0-28 6"
        stroke="white"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path
        d="M18 45a19 19 0 0 0 28-6"
        stroke="white"
        strokeWidth="4.6"
        strokeLinecap="round"
        opacity=".72"
      />
      <path
        d="M43 18h6v6M21 46h-6v-6"
        stroke="white"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M25 38V26M33 42V22M41 38V26"
        stroke="white"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CaptionGlyph() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" role="img">
      <rect x="13" y="18" width="38" height="28" rx="9" stroke="white" strokeWidth="4.6" />
      <circle cx="22" cy="27" r="3.6" fill="#bbf7d0" />
      <path
        d="M29 27h12M23 37h18"
        stroke="white"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <path
        d="M43 37h7l-3-3"
        stroke="white"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CiviGlyph() {
  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" role="img">
      <circle cx="45" cy="19" r="4.4" fill="#bbf7d0" />
      <path
        d="M42 20.5a17 17 0 1 0 0 23"
        stroke="white"
        strokeWidth="5.6"
        strokeLinecap="round"
      />
      <path
        d="M26 38V26M34 42V22"
        stroke="white"
        strokeWidth="4.8"
        strokeLinecap="round"
      />
      <path
        d="M40 34h8l-3-3"
        stroke="white"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".9"
      />
    </svg>
  );
}

export function BrandLogo({ size = "sm", variant = "live", className = "" }: Props) {
  const isLarge = size === "lg";
  const boxSize = isLarge ? "h-24 w-24 rounded-[1.75rem]" : "h-12 w-12 rounded-2xl";
  const glyphSize = isLarge ? "h-16 w-16" : "h-9 w-9";
  const Glyph = variant === "loop"
    ? LoopGlyph
    : variant === "caption"
      ? CaptionGlyph
      : variant === "civi"
        ? CiviGlyph
        : LiveGlyph;

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden text-white shadow-lg ring-1 ring-white/20 ${LOGO_SURFACE[variant]} ${boxSize} ${className}`}
      aria-hidden
    >
      <span className="absolute -left-7 -top-7 h-16 w-16 rounded-full bg-white/20 blur-xl" />
      <span className="absolute -bottom-6 right-0 h-14 w-14 rounded-full bg-cyan-200/18 blur-xl" />
      <span className={`relative ${glyphSize}`}>
        <Glyph />
      </span>
    </div>
  );
}
