import { FEATURE_ELAPSED_TIME_DISPLAY } from '@datung/shared';

// PRESENTATION-LAYER ONLY (CLAUDE.md rule 8).
//
// This renders a label from two timestamps at paint time. It is never
// persisted, never synced, and no column anywhere stores it. It carries no
// labor-law meaning under Article 82 of the Philippine Labor Code, and it is
// not a basis for pay. Behind FEATURE_ELAPSED_TIME_DISPLAY so it can be
// switched off without touching what is recorded. Ask before changing this.
//
// Returns null when the flag is off — callers must render nothing at all in
// that case, not a placeholder.
export function elapsedLabelSince(
  openedAtMs: number,
  nowMs: number,
): string | null {
  if (!FEATURE_ELAPSED_TIME_DISPLAY) return null;
  // A rewound device clock produces a negative value. Clamp rather than show
  // nonsense; the server sees the real timeline either way.
  const minutesTotal = Math.max(0, Math.floor((nowMs - openedAtMs) / 60_000));
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}
