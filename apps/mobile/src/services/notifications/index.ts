import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { supabase } from '../../lib/supabaseClient';
import { getOpenSessionLocal } from '../location/openSession.ts';
import { syncStatusStore } from '../sync/statusStore.ts';
import {
  NOTIFICATION_IDS,
  LOCAL_COPY,
  isWorkingDay,
  planLocalNotifications,
  shouldWarnSyncStalled,
} from './copy.ts';

// Notification wiring. Two separate systems with different failure modes:
//
//   LOCAL  — scheduled on the device, fires with ZERO connectivity. This is
//            the agent-facing half, and it is the half that matters most,
//            because the agent who forgot to check in is often the one with
//            no signal.
//   PUSH   — FCM, server-triggered, supervisor-facing. Requires the network
//            by definition.
//
// PERMISSION IS NEVER REQUESTED AT FIRST LAUNCH. Android 13+ requires
// POST_NOTIFICATIONS at runtime, and a permission dialog thrown at someone
// before they know what the app is gets denied. We ask AFTER consent, when
// the agent has just read what the app does and why.
//
// A DENIAL MUST NEVER BREAK ATTENDANCE. Every call below is wrapped: if
// notifications are refused or the plugin errors, check-in, tracking and sync
// carry on untouched. Reminders are a courtesy, not a dependency.

let permissionAsked = false;

async function ensurePermission(): Promise<boolean> {
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    if (current.display === 'denied') return false;
    const asked = await LocalNotifications.requestPermissions();
    return asked.display === 'granted';
  } catch {
    return false;
  }
}

/**
 * Call this ONCE, right after the agent accepts the privacy notice — not at
 * launch. Requests POST_NOTIFICATIONS for both local and push, registers the
 * FCM token, and schedules the day's local reminders.
 *
 * Returns whether permission was granted, for telemetry only; callers must
 * not branch attendance behaviour on it.
 */
export async function initNotificationsAfterConsent(
  deviceId: string | null,
): Promise<boolean> {
  if (permissionAsked) return true;
  permissionAsked = true;

  const granted = await ensurePermission();
  if (!granted) {
    // Explicitly fine. The agent can still work all day; they simply will not
    // be nudged. Do not retry on every launch — that is how an app becomes
    // the one people uninstall.
    return false;
  }

  await rescheduleLocalNotifications();
  await registerPushToken(deviceId);
  return true;
}

/**
 * Recomputes and replaces the local schedule. Safe to call often — every
 * notification has a stable id, so this replaces rather than stacks.
 * Called after check-in, after check-out, and on app resume.
 */
export async function rescheduleLocalNotifications(): Promise<void> {
  try {
    const openSession = await getOpenSessionLocal();
    const plan = planLocalNotifications({
      hasOpenSession: openSession !== null,
      isWorkingDay: isWorkingDay(new Date()),
    });

    // Clear the reminder ids we own, then lay down the new plan. Anything not
    // in the plan simply stays cancelled.
    await LocalNotifications.cancel({
      notifications: [
        { id: NOTIFICATION_IDS.notCheckedIn },
        { id: NOTIFICATION_IDS.checkOutReminderEvening },
        { id: NOTIFICATION_IDS.checkOutReminderNight },
      ],
    });

    if (plan.length === 0) return;
    await LocalNotifications.schedule({
      notifications: plan.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        schedule: {
          // Daily at a wall-clock time, using the DEVICE's local timezone,
          // which for this workforce is always Asia/Manila.
          on: { hour: n.hour, minute: n.minute },
          allowWhileIdle: true,
        },
      })),
    });
  } catch {
    // Never let a notification failure surface to the agent mid-task.
  }
}

/** Fires the sync-stall warning when the outbox has been stuck for 4+ hours. */
export async function checkSyncStallNotification(): Promise<void> {
  try {
    const status = syncStatusStore.get();
    if (
      !shouldWarnSyncStalled({
        pendingCount: status.pending,
        oldestPendingAgeMinutes: status.oldestPendingAgeMinutes,
      })
    ) {
      await LocalNotifications.cancel({
        notifications: [{ id: NOTIFICATION_IDS.syncStalled }],
      });
      return;
    }
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIFICATION_IDS.syncStalled,
          title: LOCAL_COPY.syncStalled.title,
          body: LOCAL_COPY.syncStalled.body,
          schedule: { at: new Date(Date.now() + 5_000) },
        },
      ],
    });
  } catch {
    // Non-fatal.
  }
}

/**
 * Registers the device with FCM and stores the token on the devices row.
 *
 * The token is written through set_push_token(), which checks the device is
 * the agent's CURRENT binding. On rebind the token is cleared by a database
 * trigger, so an agent's alerts never follow a handset they no longer carry.
 */
export async function registerPushToken(deviceId: string | null): Promise<void> {
  if (deviceId === null) return;
  try {
    const permission = await PushNotifications.checkPermissions();
    if (permission.receive !== 'granted') {
      const asked = await PushNotifications.requestPermissions();
      if (asked.receive !== 'granted') return;
    }

    await PushNotifications.addListener('registration', (token) => {
      void supabase.rpc('set_push_token', {
        p_auth_user_id: null,
        p_device_id: deviceId,
        p_token: token.value,
      });
    });
    await PushNotifications.addListener('registrationError', () => {
      // FCM unavailable (no Play Services, or a build without google-services
      // configured). Supervisors fall back to the console; agents are
      // unaffected — they receive local notifications only.
    });
    await PushNotifications.register();
  } catch {
    // Non-fatal by design.
  }
}

export { planLocalNotifications, shouldWarnSyncStalled } from './copy.ts';
