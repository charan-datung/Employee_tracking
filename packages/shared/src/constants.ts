// Agents have no real mailbox. Supabase auth requires an email, so every
// account is provisioned as <employee_no, lowercased>@datung.internal.
// The domain is reserved for this purpose and must never send real mail.
export const SYNTHETIC_EMAIL_DOMAIN = 'datung.internal' as const;

export function employeeNoToSyntheticEmail(employeeNo: string): string {
  return `${employeeNo.trim().toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

// Bump this when the privacy notice text changes in ANY user-visible way.
// A bump forces every agent through the consent gate again on next login.
// Keep versions comparable by eye: <year>-<month>-v<n>.
export const PRIVACY_POLICY_VERSION = '2026-07-v1' as const;

// How long the app may keep operating on a cached profile when token refresh
// fails while offline. After this, the app hard-locks until it can reach the
// server again. NOTE: measured against the device clock, which an agent can
// rewind — this gate is a UX guard, not a security boundary. The server never
// accepts a stale token regardless of what the client believes.
export const OFFLINE_GRACE_HOURS = 72 as const;

// Device-rebind request codes: 6 chars from an alphabet with no 0/O/1/I/L so
// they survive being read out over a bad phone line. Generated and verified
// server-side only.
export const REQUEST_CODE_LENGTH = 6 as const;
export const REQUEST_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' as const;

// A session open longer than this is not a real work day — the agent forgot
// to check out. The server auto-closes past this mark (hourly pg_cron job,
// status 'auto_closed', NULL close coordinates). The CLIENT stops interval
// tracking at the same mark, deliberately a beat earlier than the server's
// hourly sweep: continuing to sample location for days because someone forgot
// to tap a button is exactly the disproportionate tracking RA 10173 forbids
// (CLAUDE.md rule 4).
export const SESSION_MAX_HOURS = 16 as const;

// Presentation-layer elapsed-time display, behind a flag per CLAUDE.md rule 8.
// This is a LABEL RENDERED FROM two timestamps at paint time. It is never
// persisted, never synced, never stored in any column, and carries no
// labor-law meaning under Article 82 of the Labor Code. Turning it off must
// never change what is recorded — only what is shown. Ask before changing.
export const FEATURE_ELAPSED_TIME_DISPLAY = true as const;

// Repeated failures to obtain any usable fix stop being bad luck and start
// being a signal (dead GPS chip, permanently indoors, deliberate jamming).
export const INSUFFICIENT_SAMPLES_FLAG_THRESHOLD = 3 as const;

// Supabase Storage bucket for check-in/check-out/visit photos. Objects are
// keyed <agent_id>/<photo_uuid>.jpg; uploads are TUS-resumable.
export const STORAGE_BUCKET_PHOTOS = 'field-photos' as const;

// Retention periods surfaced in the privacy notice. TODO: confirm both with
// the Data Protection Officer before production release — the notice text
// quotes these numbers.
export const RETENTION_RAW_LOCATION_DAYS = 90 as const;
export const RETENTION_ATTENDANCE_RECORDS_YEARS = 5 as const;
