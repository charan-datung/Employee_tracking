import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  setOpenSessionLocal,
  startIntervalTracking,
  type VerifiedFix,
} from '../services/location/index.ts';
import { signalsFromFix, syncApi, type SavedPhoto } from '../services/sync/index.ts';
import { useAuth } from '../features/auth/AuthProvider';
import { useAttendance } from '../features/attendance/AttendanceProvider.tsx';
import { AttendanceCaptureFlow } from '../features/attendance/AttendanceCaptureFlow.tsx';
import {
  BatteryOptimisationNotice,
  hasSeenBatteryNotice,
} from '../features/attendance/BatteryOptimisationNotice.tsx';

// Route component.
export default function CheckInPage() {
  const { agent, deviceId } = useAuth();
  const { session, loading, refresh } = useAttendance();
  const navigate = useNavigate();
  const [showBatteryNotice, setShowBatteryNotice] = useState(false);

  // Check-in while a session is already open is REFUSED — the agent is sent
  // back to the active session rather than opening a second one. The database
  // enforces this too (one open session per agent, partial unique index).
  useEffect(() => {
    if (!loading && session !== null && !showBatteryNotice) {
      navigate('/', { replace: true });
    }
  }, [loading, session, showBatteryNotice, navigate]);

  const complete = useCallback(
    async (fix: VerifiedFix, photo: SavedPhoto) => {
      if (agent === null || deviceId === null) {
        throw new Error('missing agent or device binding');
      }
      const sessionId = crypto.randomUUID();

      // 1. Local commit: mirror row + outbox row in one SQLite transaction.
      await syncApi.enqueueSessionOpen({
        sessionId,
        agentId: agent.id,
        deviceId,
        branchId: agent.branch_id,
        openedAtDeviceMs: fix.captured_at_device,
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracy_m,
        isMocked: fix.is_mocked,
        deviceUptimeMs: fix.device_uptime_ms,
        signals: signalsFromFix(fix),
        photo,
      });

      // 2. Open the rule-4 gate BEFORE arming the watcher —
      //    startIntervalTracking throws without it, by design.
      await setOpenSessionLocal({ id: sessionId, agentId: agent.id });
      await startIntervalTracking(sessionId);
      await refresh();

      if (await hasSeenBatteryNotice()) {
        navigate('/', { replace: true });
      } else {
        setShowBatteryNotice(true);
      }
    },
    [agent, deviceId, refresh, navigate],
  );

  if (showBatteryNotice) {
    return (
      <BatteryOptimisationNotice onDone={() => navigate('/', { replace: true })} />
    );
  }

  if (agent === null) return null;

  return (
    <AttendanceCaptureFlow
      purpose="check_in"
      title="Check-in"
      agentId={agent.id}
      sessionId={null}
      onComplete={complete}
      onCancel={() => navigate('/', { replace: true })}
    />
  );
}
