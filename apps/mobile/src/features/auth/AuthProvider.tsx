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
import { z } from 'zod';
import { Network } from '@capacitor/network';
import {
  PRIVACY_POLICY_VERSION,
  agentProfileSchema,
  employeeNoToSyntheticEmail,
  type AgentProfile,
} from '@datung/shared';
import { supabase } from '../../lib/supabaseClient';
import { kvStore } from '../../lib/kvStore';
import { readDeviceIdentity } from '../../lib/deviceIdentity';
import { isWithinOfflineGrace } from './offlineGrace';
import { startSyncEngine } from '../../services/sync/index.ts';
import { stopIntervalTracking } from '../../services/location/index.ts';
import {
  fetchOwnAgent,
  hasCurrentConsent,
  recordConsent,
  registerDevice,
} from './api';

// ---------------------------------------------------------------------------
// Auth phase machine
//
//   booting ──► signed_out ──login──► (gates) ──► ready
//                                │
//                                ├─► device_blocked   (no proceed path)
//                                ├─► consent_required (must sign to continue)
//                                └─► offline_locked   (>72h without server)
// ---------------------------------------------------------------------------

export type AuthPhase =
  | 'booting'
  | 'signed_out'
  | 'device_blocked'
  | 'consent_required'
  | 'offline_locked'
  | 'ready';

export type LoginFailure = 'invalid_credentials' | 'offline' | 'unavailable';

interface AuthState {
  phase: AuthPhase;
  agent: AgentProfile | null;
  deviceId: string | null;
  requestCode: string | null;
  isOffline: boolean;
}

interface AuthContextValue extends AuthState {
  login(employeeNo: string, password: string): Promise<LoginFailure | null>;
  logout(): Promise<void>;
  acceptConsent(): Promise<void>;
  retryDeviceCheck(): Promise<void>;
  retryBootstrap(): Promise<void>;
}

// Profile cached ONLY after every gate has passed online; it is what offline
// cold starts run on, inside the 72h grace window. Storage content is a trust
// boundary like any other — validate on read.
const cachedProfileSchema = z.object({
  agent: agentProfileSchema,
  deviceId: z.uuid(),
  consentVersion: z.string(),
  lastOnlineAuthAt: z.number(),
});
type CachedProfile = z.infer<typeof cachedProfileSchema>;

const CACHE_KEY = 'datung.auth.profile';

async function loadCachedProfile(): Promise<CachedProfile | null> {
  const raw = await kvStore.get(CACHE_KEY);
  if (raw === null) return null;
  try {
    return cachedProfileSchema.parse(JSON.parse(raw));
  } catch {
    await kvStore.remove(CACHE_KEY);
    return null;
  }
}

async function saveCachedProfile(profile: CachedProfile): Promise<void> {
  await kvStore.set(CACHE_KEY, JSON.stringify(profile));
}

// Auth-dead means the server actively rejected us (revoked/expired beyond
// refresh); anything transport-shaped counts as "maybe offline".
function isAuthRejection(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return status === 400 || status === 401 || status === 403;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    phase: 'booting',
    agent: null,
    deviceId: null,
    requestCode: null,
    isOffline: false,
  });
  const bootedRef = useRef(false);

  const toSignedOut = useCallback(async () => {
    await kvStore.remove(CACHE_KEY);
    setState({
      phase: 'signed_out',
      agent: null,
      deviceId: null,
      requestCode: null,
      isOffline: false,
    });
  }, []);

  // Online path after a valid session exists: agent row -> device binding ->
  // consent -> ready. Order matters: a mismatched device never reaches the
  // consent screen, and nothing is cached until every gate has passed.
  const runGates = useCallback(async (authUserId: string) => {
    const agent = await fetchOwnAgent(authUserId);
    if (agent === null) {
      // Auth user with no agent row — nothing this app can do with it.
      await supabase.auth.signOut().catch(() => undefined);
      await toSignedOut();
      return;
    }

    const identity = await readDeviceIdentity();
    const registration = await registerDevice(identity);

    if (registration.status === 'blocked') {
      setState({
        phase: 'device_blocked',
        agent,
        deviceId: null,
        requestCode: registration.request_code,
        isOffline: false,
      });
      return;
    }

    const deviceId = registration.device_id;
    const consented = await hasCurrentConsent(agent.id);
    if (!consented) {
      setState({
        phase: 'consent_required',
        agent,
        deviceId,
        requestCode: null,
        isOffline: false,
      });
      return;
    }

    await saveCachedProfile({
      agent,
      deviceId,
      consentVersion: PRIVACY_POLICY_VERSION,
      lastOnlineAuthAt: Date.now(),
    });
    setState({
      phase: 'ready',
      agent,
      deviceId,
      requestCode: null,
      isOffline: false,
    });
  }, [toSignedOut]);

  const resumeOffline = useCallback(async () => {
    const cached = await loadCachedProfile();
    if (cached === null) {
      await toSignedOut();
      return;
    }
    // Policy bumped by an app update while offline: consent must be re-signed
    // online, so the cached profile cannot carry the user.
    if (cached.consentVersion !== PRIVACY_POLICY_VERSION) {
      await toSignedOut();
      return;
    }
    if (!isWithinOfflineGrace(cached.lastOnlineAuthAt, Date.now())) {
      setState({
        phase: 'offline_locked',
        agent: cached.agent,
        deviceId: cached.deviceId,
        requestCode: null,
        isOffline: true,
      });
      return;
    }
    setState({
      phase: 'ready',
      agent: cached.agent,
      deviceId: cached.deviceId,
      requestCode: null,
      isOffline: true,
    });
  }, [toSignedOut]);

  const bootstrap = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'booting' }));

    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session === null) {
      await toSignedOut();
      return;
    }

    const { connected } = await Network.getStatus();
    if (!connected) {
      await resumeOffline();
      return;
    }

    try {
      const { data, error } = await supabase.auth.getUser();
      if (error !== null || data.user === null) {
        if (error !== null && isAuthRejection(error)) {
          await supabase.auth.signOut().catch(() => undefined);
          await toSignedOut();
        } else {
          await resumeOffline();
        }
        return;
      }
      await runGates(data.user.id);
    } catch {
      // Transport failure between the connectivity check and the call.
      await resumeOffline();
    }
  }, [resumeOffline, runGates, toSignedOut]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  // The sync engine runs whenever the app is usable; starting it again after
  // a re-login just kicks a drain (startSyncEngine is idempotent).
  useEffect(() => {
    if (state.phase === 'ready') void startSyncEngine();
  }, [state.phase]);

  // Every successful online token refresh renews the 72h offline allowance.
  useEffect(() => {
    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'TOKEN_REFRESHED') {
        void loadCachedProfile().then((cached) => {
          if (cached !== null) {
            void saveCachedProfile({ ...cached, lastOnlineAuthAt: Date.now() });
          }
        });
      }
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const login = useCallback(
    async (employeeNo: string, password: string): Promise<LoginFailure | null> => {
      const { connected } = await Network.getStatus();
      if (!connected) return 'offline';

      const { data, error } = await supabase.auth.signInWithPassword({
        email: employeeNoToSyntheticEmail(employeeNo),
        password,
      });
      if (error !== null || data.user === null) {
        // Generic on purpose: never reveal whether an employee_no exists.
        return error !== null && !isAuthRejection(error)
          ? 'unavailable'
          : 'invalid_credentials';
      }

      try {
        await runGates(data.user.id);
        return null;
      } catch {
        await supabase.auth.signOut().catch(() => undefined);
        await toSignedOut();
        return 'unavailable';
      }
    },
    [runGates, toSignedOut],
  );

  const logout = useCallback(async () => {
    // Stop sampling before anything else: a logged-out agent is not on an
    // observable shift, whatever the local session record says (CLAUDE.md
    // rule 4). The open-session record itself is deliberately KEPT — if the
    // same agent logs back in mid-day, tracking re-arms and their check-in
    // still stands.
    await stopIntervalTracking().catch(() => undefined);
    // scope 'local' + catch: logging out must work offline too.
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    await toSignedOut();
  }, [toSignedOut]);

  const acceptConsent = useCallback(async () => {
    if (state.agent === null || state.deviceId === null) return;
    await recordConsent(state.agent.id, state.deviceId);
    await saveCachedProfile({
      agent: state.agent,
      deviceId: state.deviceId,
      consentVersion: PRIVACY_POLICY_VERSION,
      lastOnlineAuthAt: Date.now(),
    });
    setState((s) => ({ ...s, phase: 'ready', requestCode: null }));
  }, [state.agent, state.deviceId]);

  const retryDeviceCheck = useCallback(async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user === null) {
      await toSignedOut();
      return;
    }
    await runGates(data.user.id);
  }, [runGates, toSignedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      logout,
      acceptConsent,
      retryDeviceCheck,
      retryBootstrap: bootstrap,
    }),
    [state, login, logout, acceptConsent, retryDeviceCheck, bootstrap],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
