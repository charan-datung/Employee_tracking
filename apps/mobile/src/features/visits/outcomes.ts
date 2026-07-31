// Visit outcomes. Mirrors the public.visit_outcome enum exactly.
//
// CONTACT OUTCOME ONLY — no amounts, no balances, no receipts (CLAUDE.md
// rule 7). 'contacted_paid' records THAT a payment was discussed/made, never
// how much. Odoo owns money.

export const VISIT_OUTCOMES = [
  'contacted_paid',
  'contacted_promised',
  'contacted_refused',
  'not_home',
  'wrong_address',
  'closed_business',
  'client_relocated',
  'other',
] as const;

export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export interface OutcomeOption {
  value: VisitOutcome;
  label: string;
  hint: string;
  tone: 'good' | 'neutral' | 'bad';
}

// Large one-tap buttons, Taglish, ordered by how often a collector taps them.
export const OUTCOME_OPTIONS: readonly OutcomeOption[] = [
  { value: 'contacted_paid', label: 'Nagbayad', hint: 'Nakausap at nagbayad', tone: 'good' },
  { value: 'contacted_promised', label: 'Nangako', hint: 'Nakausap, may pangako', tone: 'neutral' },
  { value: 'contacted_refused', label: 'Ayaw magbayad', hint: 'Nakausap, tumanggi', tone: 'bad' },
  { value: 'not_home', label: 'Wala sa bahay', hint: 'Walang tao', tone: 'neutral' },
  { value: 'wrong_address', label: 'Maling address', hint: 'Hindi dito nakatira', tone: 'bad' },
  { value: 'closed_business', label: 'Sarado ang negosyo', hint: 'Hindi na bukas', tone: 'bad' },
  { value: 'client_relocated', label: 'Lumipat', hint: 'Lumipat ng tirahan', tone: 'bad' },
  { value: 'other', label: 'Iba pa', hint: 'Kailangan ng paliwanag', tone: 'neutral' },
] as const;
