import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  clearOpenSessionLocal,
  stopIntervalTracking,
  type VerifiedFix,
} from '../services/location/index.ts';
import { syncApi, type SavedPhoto } from '../services/sync/index.ts';
import { clearLastPosition } from '../features/clients/lastPosition.ts';
import { useAuth } from '../features/auth/AuthProvider';
import { useAttendance } from '../features/attendance/AttendanceProvider.tsx';
import { AttendanceCaptureFlow } from '../features/attendance/AttendanceCaptureFlow.tsx';

// Route component.
export default function CheckOutPage() {
  const { agent } = useAuth();
  const { session, loading, refresh } = useAttendance();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && session === null) navigate('/', { replace: true });
  }, [loading, session, navigate]);

  const complete = useCallback(
    async (fix: VerifiedFix, photo: SavedPhoto) => {
      if (session === null) throw new Error('no open session');
      const sessionId = session.id;

      // Stop sampling FIRST: the moment the agent has a verified check-out
      // fix, there is no lawful basis to keep collecting location.
      await stopIntervalTracking();
      await clearOpenSessionLocal();
      // The cached position only exists to serve an open session; a checked-out
      // agent leaves no position behind (CLAUDE.md rule 4).
      await clearLastPosition();

      await syncApi.enqueueSessionClose({
        sessionId,
        closedAtDeviceMs: fix.captured_at_device,
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracy_m,
        isMocked: fix.is_mocked,
        deviceUptimeMs: fix.device_uptime_ms,
        photo,
      });

      await refresh();
      navigate('/', { replace: true });
    },
    [session, refresh, navigate],
  );

  if (agent === null || session === null) return null;

  return (
    <AttendanceCaptureFlow
      purpose="check_out"
      title="Check-out"
      agentId={agent.id}
      sessionId={session.id}
      onComplete={complete}
      onCancel={() => navigate('/', { replace: true })}
    />
  );
}
