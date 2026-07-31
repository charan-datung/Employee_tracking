import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOFENCE_HARD_LIMIT_M,
  MIN_NOTES_LENGTH,
  canSaveVisit,
  evaluateGate,
  formatDistance,
  notesRequired,
  photoRequired,
  visitBlockers,
  type GateDecision,
  type VisitDraft,
} from './gate.ts';
import { VISIT_OUTCOMES, OUTCOME_OPTIONS } from './outcomes.ts';

const draft = (over: Partial<VisitDraft> = {}): VisitDraft => ({
  outcome: 'contacted_paid',
  notes: '',
  hasPhoto: false,
  geofenceMissReason: null,
  ...over,
});

test('inside the client radius proceeds with nothing to explain', () => {
  const gate = evaluateGate(80, 120);
  assert.equal(gate.kind, 'inside');
  assert.equal(canSaveVisit(draft(), gate), true);
});

test('exactly on the radius counts as inside', () => {
  assert.equal(evaluateGate(120, 120).kind, 'inside');
});

test('outside the radius but within 500m requires a reason', () => {
  const gate = evaluateGate(230, 120);
  assert.equal(gate.kind, 'reason_required');
  assert.deepEqual(visitBlockers(draft(), gate), ['reason_missing']);
  assert.equal(canSaveVisit(draft(), gate), false);
  assert.equal(
    canSaveVisit(draft({ geofenceMissReason: 'Mali ang pin sa mapa' }), gate),
    true,
  );
});

test('exactly 500m still allows a reasoned visit; past it is blocked', () => {
  assert.equal(evaluateGate(GEOFENCE_HARD_LIMIT_M, 120).kind, 'reason_required');
  assert.equal(evaluateGate(GEOFENCE_HARD_LIMIT_M + 1, 120).kind, 'blocked');
});

test('beyond 500m is blocked with a human distance and has NO override', () => {
  const gate = evaluateGate(2340, 120);
  assert.equal(gate.kind, 'blocked');
  assert.equal(gate.kind === 'blocked' && gate.distanceLabel, '2.3 km');
  // Not even a complete draft with a reason can save past the hard limit.
  const complete = draft({
    geofenceMissReason: 'Mali ang pin sa mapa',
    notes: 'this is a long enough explanation',
    hasPhoto: true,
  });
  assert.equal(canSaveVisit(complete, gate), false);
});

test('a client with no pin is not the agent fault: proceed, no reason needed', () => {
  const gate = evaluateGate(null, 120);
  assert.equal(gate.kind, 'no_pin');
  assert.equal(canSaveVisit(draft(), gate), true);
});

test('distance formatting switches to km at 1000m', () => {
  assert.equal(formatDistance(230.4), '230 m');
  assert.equal(formatDistance(999), '999 m');
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(2340), '2.3 km');
});

test('notes are required only for other and wrong_address, at 15+ chars', () => {
  const required = VISIT_OUTCOMES.filter(notesRequired);
  assert.deepEqual([...required].sort(), ['other', 'wrong_address']);

  const gate: GateDecision = { kind: 'inside', distanceM: 10 };
  assert.deepEqual(
    visitBlockers(draft({ outcome: 'other', notes: 'wala' }), gate),
    ['notes_too_short'],
  );
  assert.equal('a'.repeat(MIN_NOTES_LENGTH).length, 15);
  assert.deepEqual(
    visitBlockers(
      draft({ outcome: 'other', notes: 'a'.repeat(MIN_NOTES_LENGTH) }),
      gate,
    ),
    [],
  );
  // Whitespace padding does not satisfy the minimum.
  assert.deepEqual(
    visitBlockers(draft({ outcome: 'other', notes: '   short   ' }), gate),
    ['notes_too_short'],
  );
});

test('photo is required for the four outcomes nobody can corroborate', () => {
  const required = VISIT_OUTCOMES.filter(photoRequired);
  assert.deepEqual(
    [...required].sort(),
    ['client_relocated', 'closed_business', 'not_home', 'wrong_address'],
  );
  const gate: GateDecision = { kind: 'inside', distanceM: 10 };
  assert.deepEqual(
    visitBlockers(draft({ outcome: 'not_home' }), gate),
    ['photo_missing'],
  );
  assert.deepEqual(
    visitBlockers(draft({ outcome: 'not_home', hasPhoto: true }), gate),
    [],
  );
  // Photo stays optional for a contacted outcome.
  assert.deepEqual(visitBlockers(draft({ outcome: 'contacted_paid' }), gate), []);
});

test('wrong_address needs BOTH notes and a photo', () => {
  const gate: GateDecision = { kind: 'inside', distanceM: 10 };
  assert.deepEqual(
    visitBlockers(draft({ outcome: 'wrong_address' }), gate).sort(),
    ['notes_too_short', 'photo_missing'],
  );
});

test('a missing outcome is reported before its dependent rules', () => {
  const gate: GateDecision = { kind: 'inside', distanceM: 10 };
  assert.deepEqual(visitBlockers(draft({ outcome: null }), gate), ['outcome_missing']);
});

test('reason and outcome blockers surface together off-geofence', () => {
  const gate = evaluateGate(300, 120);
  assert.deepEqual(
    visitBlockers(draft({ outcome: null }), gate),
    ['reason_missing', 'outcome_missing'],
  );
});

test('every enum outcome has a Taglish button, and no extras exist', () => {
  assert.deepEqual(
    OUTCOME_OPTIONS.map((o) => o.value).sort(),
    [...VISIT_OUTCOMES].sort(),
  );
  for (const option of OUTCOME_OPTIONS) {
    assert.ok(option.label.length > 0 && option.hint.length > 0, option.value);
  }
});

test('no outcome label mentions money (rule 7: outcome only)', () => {
  const banned = /piso|php|₱|halaga|bayad na \d|amount|balance/i;
  for (const option of OUTCOME_OPTIONS) {
    assert.doesNotMatch(`${option.label} ${option.hint}`, banned, option.value);
  }
});
