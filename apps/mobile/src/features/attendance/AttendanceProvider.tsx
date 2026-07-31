import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { App } from '@capacitor/app';
import { SESSION_MAX_HOURS } from '@datung/shared';
import {
  checkLocationPermission,
  clearOpenSessionLocal,
  rearmTrackingIfSessionOpen,
  stopIntervalTracking,
} from '../../services/location/index.ts';
import { reportIntegrityFlag } from '../../services/sync/index.ts';
import {
  getOpenSessionDetail,
  getVisitBreakdown,
  type OpenSessionDetail,
  type VisitBreakdown,
} from './queries.ts';

// Owns "is a session open?" for the whole app, plus the four edge cases that
// must never be discovered in the field:
//   * app killed with a session open  -> re-arm tracking on launch + banner
//   * session left open past the limit -> stop tracking locally, banner
//   * location permission revoked mid-session -> flag, block visit logging,
//     never silently stop tracking
//   * check-in while already open -> refused (canCheckIn is false)

export type SessionBanner = 'resumed_after_restart' | 'auto_closed_locally' | null;

interface AttendanceState {
  loading: boolean;
  session: OpenSessionDetail | null;
  visits: VisitBreakdown;
  banner: SessionBanner;
  /** Location permission lost while a session is open. */
  permissionRevoked: boolean;
}

interface AttendanceContextValue extends AttendanceState {
  canCheckIn: boolean;
  canLogVisit: boolean;
  refresh(): Promise<void>;
  dismissBanner(): void;
  recheckPermission(): Promise<void>;
}

const EMPTY_VISITS: VisitBreakdown = { total: 0, byOutcome: [] };
const PERMISSION_POLL_MS = 60_000;

const AttendanceContext = createContext<AttendanceContextValue | null>(null);

export function AttendanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AttendanceState>({
    loading: true,
    session: null,
    visits: EMPTY_VISITS,
    banner: null,
    permissionRevoked: false,
  });
  const bootedRef = useRef(false);
  // Flags are raised once per revocation episode, not once per poll.
  const revocationReportedRef = useRef(false);

  const refresh = useCallback(async (opts?: { coldStart?: boolean }) => {
    // The provider mounts above the auth gates, so this runs while the agent
    // is still on the login screen. A local-DB failure must never wedge the
    // app there — render "no session" and let the next refresh retry.
    let session: OpenSessionDetail | null;
    try {
      session = await getOpenSessionDetail();
    } catch {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    if (session === null) {
      setState((s) => ({
        ...s,
        loading: false,
        session: null,
        visits: EMPTY_VISITS,
        permissionRevoked: false,
      }));
      return;
    }

    // Session left open past the limit: the agent forgot to check out. Stop
    // sampling NOW — the server's hourly sweep will auto-close it, and
    // tracking someone for days because of a missed tap is exactly the
    // disproportionate collection rule 4 forbids.
    const ageHours = (Date.now() - session.openedAtDeviceMs) / 3_600_000;
    if (ageHours >= SESSION_MAX_HOURS) {
      await stopIntervalTracking();
      await clearOpenSessionLocal();
      setState((s) => ({
        ...s,
        loading: false,
        session: null,
        visits: EMPTY_VISITS,
        banner: 'auto_closed_locally',
        permissionRevoked: false,
      }));
      return;
    }

    // App was killed with a session open: re-arm the foreground service.
    // rearmTrackingIfSessionOpen is idempotent, so this is safe on resume.
    let resumed = false;
    try {
      resumed = await rearmTrackingIfSessionOpen();
    } catch {
      // NoOpenSessionError means the kvStore gate disagrees with SQLite;
      // the permission/banner state below still renders honestly.
      resumed = false;
    }

    const visits = await getVisitBreakdown(session.id);
    setState((s) => ({
      ...s,
      loading: false,
      session,
      visits,
      banner:
        opts?.coldStart === true && resumed ? 'resumed_after_restart' : s.banner,
    }));
  }, []);

  const recheckPermission = useCallback(async () => {
    const session = await getOpenSessionDetail();
    if (session === null) {
      revocationReportedRef.current = false;
      setState((s) => ({ ...s, permissionRevoked: false }));
      return;
    }
    const permission = await checkLocationPermission();
    const revoked = permission === 'denied';

    if (revoked && !revocationReportedRef.current) {
      revocationReportedRef.current = true;
      // NOTE: tracking is deliberately NOT stopped here. Silently stopping
      // would leave a gap nobody can explain; the agent is blocked from
      // logging visits and told loudly instead, and the server sees the flag.
      await reportIntegrityFlag({
        flag_type: 'permission_revoked',
        severity: 'critical',
        session_id: session.id,
        detail: { kind: 'location_permission_revoked_mid_session' },
      });
    }
    if (!revoked) revocationReportedRef.current = false;
    setState((s) => ({ ...s, permissionRevoked: revoked }));
  }, []);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async () => {
      await refresh({ coldStart: true });
      await recheckPermission();
    })();
  }, [refresh, recheckPermission]);

  useEffect(() => {
    const listener = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return;
      void (async () => {
        await refresh();
        await recheckPermission();
      })();
    });
    return () => {
      void listener.then((l) => l.remove());
    };
  }, [refresh, recheckPermission]);

  useEffect(() => {
    if (state.session === null) return;
    const timer = setInterval(() => void recheckPermission(), PERMISSION_POLL_MS);
    return () => clearInterval(timer);
  }, [state.session, recheckPermission]);

  const value = useMemo<AttendanceContextValue>(
    () => ({
      ...state,
      // Check-in while a session is already open is refused structurally.
      canCheckIn: !state.loading && state.session === null,
      canLogVisit: state.session !== null && !state.permissionRevoked,
      refresh: () => refresh(),
      dismissBanner: () => setState((s) => ({ ...s, banner: null })),
      recheckPermission,
    }),
    [state, refresh, recheckPermission],
  );

  return (
    <AttendanceContext.Provider value={value}>
      {children}
    </AttendanceContext.Provider>
  );
}

export function useAttendance(): AttendanceContextValue {
  const ctx = useContext(AttendanceContext);
  if (ctx === null) {
    throw new Error('useAttendance must be used inside <AttendanceProvider>');
  }
  return ctx;
}
