// Notification copy and scheduling rules.
//
// ALL COPY IS TAGLISH AND UNDER 100 CHARACTERS — an Android notification
// truncates in the shade, and an agent glancing at a phone in a jeepney reads
// the first line or nothing. The length limit is asserted in the tests, not
// left to good intentions.
//
// Pure: no plugins, so the rules are unit-tested without a device.

export const MAX_NOTIFICATION_CHARS = 100;

// Stable numeric IDs so rescheduling REPLACES rather than stacks. Android
// keeps one pending notification per id; without fixed ids an agent who opens
// the app five times gets five 8:30 alarms.
export const NOTIFICATION_IDS = {
  notCheckedIn: 1001,
  checkOutReminderEvening: 1002,
  checkOutReminderNight: 1003,
  syncStalled: 1004,
} as const;

export const LOCAL_COPY = {
  notCheckedIn: {
    title: 'Hindi ka pa naka-check in',
    body: 'Alas-8:30 na. Mag-check in ka na para masimulan ang araw mo.',
  },
  checkOutReminder: {
    title: 'Naka-check in ka pa',
    body: 'Mag-check out ka na para matapos ang araw mo at tumigil ang tracking.',
  },
  syncStalled: {
    title: 'Hindi naka-sync ang records mo',
    body: 'May 4 oras nang hindi naipapadala. Kumonekta sa internet kapag kaya.',
  },
} as const;

// Local schedule, in Philippine time. These fire from the device, so they
// work with zero connectivity — which is the whole point: the agent who most
// needs the 8:30 nudge is the one in a dead cell.
export const LOCAL_SCHEDULE = {
  notCheckedInHour: 8,
  notCheckedInMinute: 30,
  checkOutEveningHour: 18,
  checkOutEveningMinute: 30,
  checkOutNightHour: 20,
  checkOutNightMinute: 0,
} as const;

export const SYNC_STALL_HOURS = 4;

// Monday–Saturday. Philippine field collection runs six days; Sunday nudges
// would be both wrong and corrosive. Kept as data so a scheduling change does
// not mean touching notification code.
export const WORKING_WEEKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

export function isWorkingDay(date: Date): boolean {
  return WORKING_WEEKDAYS.has(date.getDay());
}

export interface LocalNotificationPlan {
  id: number;
  title: string;
  body: string;
  hour: number;
  minute: number;
}

/**
 * What to schedule given the current session state.
 *
 * With an OPEN session: only the check-out reminders. Nagging someone to
 * check in when they already did is how an app teaches people to swipe its
 * notifications away without reading them.
 *
 * With NO open session: only the morning nudge, and only on a working day.
 */
export function planLocalNotifications(opts: {
  hasOpenSession: boolean;
  isWorkingDay: boolean;
}): LocalNotificationPlan[] {
  if (opts.hasOpenSession) {
    return [
      {
        id: NOTIFICATION_IDS.checkOutReminderEvening,
        ...LOCAL_COPY.checkOutReminder,
        hour: LOCAL_SCHEDULE.checkOutEveningHour,
        minute: LOCAL_SCHEDULE.checkOutEveningMinute,
      },
      {
        id: NOTIFICATION_IDS.checkOutReminderNight,
        ...LOCAL_COPY.checkOutReminder,
        hour: LOCAL_SCHEDULE.checkOutNightHour,
        minute: LOCAL_SCHEDULE.checkOutNightMinute,
      },
    ];
  }
  if (!opts.isWorkingDay) return [];
  return [
    {
      id: NOTIFICATION_IDS.notCheckedIn,
      ...LOCAL_COPY.notCheckedIn,
      hour: LOCAL_SCHEDULE.notCheckedInHour,
      minute: LOCAL_SCHEDULE.notCheckedInMinute,
    },
  ];
}

/** Sync-stall notification is warranted only with BOTH age and backlog. */
export function shouldWarnSyncStalled(opts: {
  pendingCount: number;
  oldestPendingAgeMinutes: number | null;
}): boolean {
  return (
    opts.pendingCount > 0 &&
    opts.oldestPendingAgeMinutes !== null &&
    opts.oldestPendingAgeMinutes >= SYNC_STALL_HOURS * 60
  );
}
