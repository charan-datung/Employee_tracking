import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_COPY,
  MAX_NOTIFICATION_CHARS,
  NOTIFICATION_IDS,
  isWorkingDay,
  planLocalNotifications,
  shouldWarnSyncStalled,
} from './copy.ts';

test('every notification string is Taglish and under 100 characters', () => {
  for (const [key, copy] of Object.entries(LOCAL_COPY)) {
    assert.ok(
      copy.title.length < MAX_NOTIFICATION_CHARS,
      `${key} title is ${copy.title.length} chars`,
    );
    assert.ok(
      copy.body.length < MAX_NOTIFICATION_CHARS,
      `${key} body is ${copy.body.length} chars`,
    );
    // A Tagalog marker in every string — these are read by field agents, not
    // by the people who commissioned the system.
    assert.match(
      `${copy.title} ${copy.body}`,
      /\b(ka|mo|na|ang|ng|para|may|hindi)\b/i,
      `${key} should read as Taglish`,
    );
  }
});

test('no open session on a working day schedules only the morning nudge', () => {
  const plan = planLocalNotifications({ hasOpenSession: false, isWorkingDay: true });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.id, NOTIFICATION_IDS.notCheckedIn);
  assert.equal(plan[0]?.hour, 8);
  assert.equal(plan[0]?.minute, 30);
});

test('an open session schedules ONLY check-out reminders, never a check-in nudge', () => {
  const plan = planLocalNotifications({ hasOpenSession: true, isWorkingDay: true });
  assert.deepEqual(
    plan.map((p) => p.id),
    [
      NOTIFICATION_IDS.checkOutReminderEvening,
      NOTIFICATION_IDS.checkOutReminderNight,
    ],
  );
  assert.deepEqual(
    plan.map((p) => [p.hour, p.minute]),
    [
      [18, 30],
      [20, 0],
    ],
  );
});

test('a rest day with no session schedules nothing at all', () => {
  assert.deepEqual(
    planLocalNotifications({ hasOpenSession: false, isWorkingDay: false }),
    [],
  );
});

test('an open session still gets check-out reminders on a rest day', () => {
  // Someone who checked in on a Sunday must still be reminded to stop
  // tracking — rule 4 does not take the weekend off.
  const plan = planLocalNotifications({ hasOpenSession: true, isWorkingDay: false });
  assert.equal(plan.length, 2);
});

test('Sunday is not a working day; Monday through Saturday are', () => {
  // 2026-08-02 is a Sunday.
  assert.equal(isWorkingDay(new Date('2026-08-02T04:00:00Z')), false);
  assert.equal(isWorkingDay(new Date('2026-08-03T04:00:00Z')), true);
  assert.equal(isWorkingDay(new Date('2026-08-08T04:00:00Z')), true);
});

test('notification ids are stable and distinct so rescheduling replaces', () => {
  const ids = Object.values(NOTIFICATION_IDS);
  assert.equal(new Set(ids).size, ids.length);
});

test('sync stall warns only with both a backlog AND four hours of age', () => {
  assert.equal(
    shouldWarnSyncStalled({ pendingCount: 12, oldestPendingAgeMinutes: 241 }),
    true,
  );
  assert.equal(
    shouldWarnSyncStalled({ pendingCount: 12, oldestPendingAgeMinutes: 100 }),
    false,
  );
  assert.equal(
    shouldWarnSyncStalled({ pendingCount: 0, oldestPendingAgeMinutes: 900 }),
    false,
  );
  assert.equal(
    shouldWarnSyncStalled({ pendingCount: 5, oldestPendingAgeMinutes: null }),
    false,
  );
});
