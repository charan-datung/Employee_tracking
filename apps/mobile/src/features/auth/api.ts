import {
  PRIVACY_POLICY_VERSION,
  agentProfileSchema,
  registerDeviceResponseSchema,
  type AgentProfile,
  type RegisterDeviceResponse,
} from '@datung/shared';
import { supabase } from '../../lib/supabaseClient';
import type { DeviceIdentity } from '../../lib/deviceIdentity';

// Every response is zod-validated at this boundary; nothing downstream
// touches unvalidated wire data.

export async function fetchOwnAgent(
  authUserId: string,
): Promise<AgentProfile | null> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, employee_no, full_name, role, branch_id, employment_status')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (error) throw error;
  if (data === null) return null;
  return agentProfileSchema.parse(data);
}

export async function registerDevice(
  identity: DeviceIdentity,
): Promise<RegisterDeviceResponse> {
  const { data, error } = await supabase.functions.invoke('register_device', {
    body: {
      android_id: identity.androidId,
      device_model: identity.deviceModel,
      manufacturer: identity.manufacturer,
      os_version: identity.osVersion,
      webview_version: identity.webviewVersion,
      app_version: identity.appVersion,
    },
  });
  if (error) throw error;
  return registerDeviceResponseSchema.parse(data);
}

export async function hasCurrentConsent(agentId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('consent_records')
    .select('id')
    .eq('agent_id', agentId)
    .eq('policy_version', PRIVACY_POLICY_VERSION)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

export async function recordConsent(
  agentId: string,
  deviceId: string,
): Promise<void> {
  // accepted_at is stamped by the DB default (server time), never sent from
  // the device.
  const { error } = await supabase.from('consent_records').insert({
    agent_id: agentId,
    policy_version: PRIVACY_POLICY_VERSION,
    device_id: deviceId,
  });
  if (error) throw error;
}
