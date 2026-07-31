// Visit policy: the geofence gate, the outcome rules, and the notes/photo
// requirements. Pure functions — no React, no plugins, no SQL — so every rule
// below is unit-tested.
//
// The gate decides WHICH SCREEN to show while offline. It is not the fact:
// visits_stamp_arrival_facts() recomputes the distance from PostGIS on
// arrival and sets arrive_distance_from_client_m / is_within_geofence, and
// the client is not granted those columns. If the two ever disagree, the
// server wins and the server flags it.

import type { VisitOutcome } from './outcomes.ts';

// Beyond this, a "visit" is not a visit. Mirrors public.geofence_hard_limit_m()
// on the server; the server flags anything past it as critical.
export const GEOFENCE_HARD_LIMIT_M = 500;

export type GateDecision =
  // Inside the client's radius: proceed, nothing to explain.
  | { kind: 'inside'; distanceM: number }
  // Outside the radius but within the hard limit: proceed ONLY with a reason.
  | { kind: 'reason_required'; distanceM: number }
  // Beyond the hard limit: no override exists. A genuinely wrong pin is a
  // back-office correction, not a field one.
  | { kind: 'blocked'; distanceM: number; distanceLabel: string }
  // The client has no pin at all. The agent cannot be blamed for that, and
  // the server records is_within_geofence as NULL (unknown), not false.
  | { kind: 'no_pin' };

export function evaluateGate(
  distanceM: number | null,
  geofenceRadiusM: number,
): GateDecision {
  if (distanceM === null) return { kind: 'no_pin' };
  if (distanceM <= geofenceRadiusM) return { kind: 'inside', distanceM };
  if (distanceM <= GEOFENCE_HARD_LIMIT_M) {
    return { kind: 'reason_required', distanceM };
  }
  return {
    kind: 'blocked',
    distanceM,
    distanceLabel: formatDistance(distanceM),
  };
}

// "230 m" under a kilometre, "2.3 km" above — the blocked message quotes this
// so the agent knows how far off they are.
export function formatDistance(metres: number): string {
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(1)} km`;
}

export const GEOFENCE_MISS_REASONS = [
  'Mali ang pin sa mapa',
  'Lumipat ang bahay',
  'Hindi ma-access',
  'Iba',
] as const;
export type GeofenceMissReason = (typeof GEOFENCE_MISS_REASONS)[number];

// Free-text notes carry the whole explanation for these two, so a one-word
// shrug is not acceptable evidence.
const NOTES_REQUIRED_FOR: ReadonlySet<VisitOutcome> = new Set([
  'other',
  'wrong_address',
]);
export const MIN_NOTES_LENGTH = 15;

// Outcomes the agent cannot corroborate by talking to anyone — the photo IS
// the evidence that they stood there and saw what they claim.
const PHOTO_REQUIRED_FOR: ReadonlySet<VisitOutcome> = new Set([
  'not_home',
  'wrong_address',
  'closed_business',
  'client_relocated',
]);

export function notesRequired(outcome: VisitOutcome): boolean {
  return NOTES_REQUIRED_FOR.has(outcome);
}

export function photoRequired(outcome: VisitOutcome): boolean {
  return PHOTO_REQUIRED_FOR.has(outcome);
}

export interface VisitDraft {
  outcome: VisitOutcome | null;
  notes: string;
  hasPhoto: boolean;
  geofenceMissReason: GeofenceMissReason | null;
}

export type VisitBlocker =
  | 'outcome_missing'
  | 'notes_too_short'
  | 'photo_missing'
  | 'reason_missing';

// Everything standing between the draft and a saveable visit, in the order a
// person would fix them. Empty array means saveable.
export function visitBlockers(
  draft: VisitDraft,
  gate: GateDecision,
): VisitBlocker[] {
  const blockers: VisitBlocker[] = [];
  if (gate.kind === 'reason_required' && draft.geofenceMissReason === null) {
    blockers.push('reason_missing');
  }
  if (draft.outcome === null) {
    blockers.push('outcome_missing');
    return blockers;
  }
  if (
    notesRequired(draft.outcome) &&
    draft.notes.trim().length < MIN_NOTES_LENGTH
  ) {
    blockers.push('notes_too_short');
  }
  if (photoRequired(draft.outcome) && !draft.hasPhoto) {
    blockers.push('photo_missing');
  }
  return blockers;
}

export function canSaveVisit(draft: VisitDraft, gate: GateDecision): boolean {
  // A blocked gate has no save path at all — not even with a reason.
  return gate.kind !== 'blocked' && visitBlockers(draft, gate).length === 0;
}
