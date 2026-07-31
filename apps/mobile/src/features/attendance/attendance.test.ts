import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectionPolicy } from './rejectionPolicy.ts';
import { oemBatteryGuide } from './oemBattery.ts';
import { elapsedLabelSince } from './elapsed.ts';
import type { LocationRejection } from '../../services/location/index.ts';

const rejection = (
  overrides: Partial<LocationRejection> & Pick<LocationRejection, 'reason'>,
): LocationRejection => ({
  ok: false,
  purpose: 'check_in',
  sample_count: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// rejectionPolicy
// ---------------------------------------------------------------------------

test('mocked raises mock_attempt_blocked IMMEDIATELY, on the first attempt', () => {
  const policy = rejectionPolicy(
    rejection({ reason: 'mocked', sample_count: 4 }),
    1,
    null,
  );
  assert.ok(policy.flag, 'a blocked attempt is a signal, not a non-event');
  assert.equal(policy.flag.flag_type, 'mock_attempt_blocked');
  assert.equal(policy.flag.severity, 'critical');
  assert.equal(policy.flag.detail['sample_count'], 4);
  assert.match(policy.body, /fake GPS/i);
  assert.match(policy.body, /Developer Options/i);
});

test('no rejection path offers a way to continue anyway', () => {
  const reasons = [
    'mocked',
    'accuracy_degraded',
    'permission_denied',
    'insufficient_samples',
    'unavailable',
  ] as const;
  for (const reason of reasons) {
    const policy = rejectionPolicy(rejection({ reason }), 1, null);
    // The only action a policy can express is a RETRY of the same verified
    // capture. There is no field that could carry a bypass.
    assert.deepEqual(
      Object.keys(policy).sort(),
      ['body', 'flag', 'retryLabel', 'retryWithPermissionRequest', 'title'],
      `policy shape must stay closed for ${reason}`,
    );
    assert.equal(policy.retryWithPermissionRequest, reason === 'permission_denied');
  }
});

test('accuracy_degraded shows the measured metres, rounded', () => {
  const policy = rejectionPolicy(
    rejection({ reason: 'accuracy_degraded', measured_accuracy_m: 180.4 }),
    1,
    null,
  );
  assert.match(policy.body, /±180m/);
  assert.match(policy.body, /Lumabas/i);
  assert.equal(policy.flag, null);
});

test('accuracy_degraded copes with a missing measurement', () => {
  const policy = rejectionPolicy(
    rejection({ reason: 'accuracy_degraded' }),
    1,
    null,
  );
  assert.doesNotMatch(policy.body, /±/);
  assert.match(policy.body, /Lumabas/i);
});

test('permission_denied explains first, then re-requests on retry', () => {
  const policy = rejectionPolicy(rejection({ reason: 'permission_denied' }), 1, null);
  assert.equal(policy.retryWithPermissionRequest, true);
  assert.equal(policy.retryLabel, 'Payagan ang Location');
  assert.equal(policy.flag, null, 'a denied permission is not an integrity event');
});

test('insufficient_samples flags only after 3 consecutive failures', () => {
  const first = rejectionPolicy(rejection({ reason: 'insufficient_samples' }), 1, null);
  const second = rejectionPolicy(rejection({ reason: 'insufficient_samples' }), 2, null);
  const third = rejectionPolicy(rejection({ reason: 'insufficient_samples' }), 3, null);
  assert.equal(first.flag, null);
  assert.equal(second.flag, null);
  assert.ok(third.flag);
  assert.equal(third.flag.flag_type, 'accuracy_degraded');
  assert.equal(third.flag.detail['consecutive_failures'], 3);
});

test('flags carry the session id when one is open (check-out path)', () => {
  const policy = rejectionPolicy(
    rejection({ reason: 'mocked', purpose: 'check_out' }),
    1,
    'session-abc',
  );
  assert.equal(policy.flag?.session_id, 'session-abc');
});

// ---------------------------------------------------------------------------
// oemBatteryGuide
// ---------------------------------------------------------------------------

test('sub-brands resolve to their parent OEM guide', () => {
  for (const brand of ['Xiaomi', 'Redmi', 'POCO']) {
    assert.equal(oemBatteryGuide(brand).key, 'xiaomi', brand);
  }
  assert.equal(oemBatteryGuide('OPPO').key, 'oppo');
  assert.equal(oemBatteryGuide('OnePlus').key, 'oppo');
  assert.equal(oemBatteryGuide('vivo').key, 'vivo');
  assert.equal(oemBatteryGuide('realme').key, 'realme');
  assert.equal(oemBatteryGuide('samsung').key, 'samsung');
  assert.equal(oemBatteryGuide('HONOR').key, 'huawei');
  assert.equal(oemBatteryGuide('Infinix').key, 'transsion');
});

test('verbose manufacturer strings still match', () => {
  assert.equal(oemBatteryGuide('Xiaomi Communications Co., Ltd').key, 'xiaomi');
  assert.equal(oemBatteryGuide('realme Chongqing Mobile').key, 'realme');
});

test('unknown or missing manufacturer falls back to generic, never crashes', () => {
  assert.equal(oemBatteryGuide('Cherry Mobile').key, 'generic');
  assert.equal(oemBatteryGuide(null).key, 'generic');
  assert.equal(oemBatteryGuide('').key, 'generic');
  assert.equal(oemBatteryGuide('   ').key, 'generic');
});

test('every OEM guide names the app and gives at least two concrete steps', () => {
  for (const brand of ['Xiaomi', 'OPPO', 'vivo', 'realme', 'samsung', 'HONOR', 'Infinix', null]) {
    const guide = oemBatteryGuide(brand);
    assert.ok(guide.steps.length >= 2, `${String(brand)} needs real steps`);
    assert.ok(
      guide.steps.some((s) => s.includes('Datung Field')),
      `${String(brand)} steps must name the app`,
    );
  }
});

// ---------------------------------------------------------------------------
// elapsed (display only — CLAUDE.md rule 8)
// ---------------------------------------------------------------------------

test('elapsed label formats hours and minutes', () => {
  const open = 1_722_400_000_000;
  assert.equal(elapsedLabelSince(open, open), '0m');
  assert.equal(elapsedLabelSince(open, open + 45 * 60_000), '45m');
  assert.equal(elapsedLabelSince(open, open + 60 * 60_000), '1h 0m');
  assert.equal(elapsedLabelSince(open, open + 135 * 60_000), '2h 15m');
});

test('a rewound device clock clamps to zero instead of showing nonsense', () => {
  const open = 1_722_400_000_000;
  assert.equal(elapsedLabelSince(open, open - 3_600_000), '0m');
});
