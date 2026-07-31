import { z } from 'zod';
import { REQUEST_CODE_ALPHABET, REQUEST_CODE_LENGTH } from './constants.ts';

export const agentRoleSchema = z.enum(['sales_agent', 'collector', 'field_supervisor']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const employmentStatusSchema = z.enum(['active', 'suspended', 'separated']);
export type EmploymentStatus = z.infer<typeof employmentStatusSchema>;

// The slice of the agents row the mobile app reads about ITSELF (RLS: own row
// only). Validate at the network boundary — never trust shape from the wire.
export const agentProfileSchema = z.object({
  id: z.uuid(),
  employee_no: z.string().min(1),
  full_name: z.string().min(1),
  role: agentRoleSchema,
  branch_id: z.uuid(),
  employment_status: employmentStatusSchema,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const requestCodeSchema = z
  .string()
  .length(REQUEST_CODE_LENGTH)
  .regex(new RegExp(`^[${REQUEST_CODE_ALPHABET}]+$`), 'invalid request code');

// ---------------------------------------------------------------------------
// register_device edge function
// ---------------------------------------------------------------------------

export const registerDeviceRequestSchema = z.object({
  android_id: z.string().min(1).max(64),
  device_model: z.string().max(120).nullable(),
  manufacturer: z.string().max(120).nullable(),
  os_version: z.string().max(60).nullable(),
  webview_version: z.string().max(60).nullable(),
  app_version: z.string().max(60).nullable(),
});
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const registerDeviceResponseSchema = z.discriminatedUnion('status', [
  // First device for this agent — bound on the spot.
  z.object({ status: z.literal('bound'), device_id: z.uuid() }),
  // Matches the current binding — info columns refreshed.
  z.object({ status: z.literal('ok'), device_id: z.uuid() }),
  // ANDROID_ID differs from the current binding — no proceed path.
  z.object({ status: z.literal('blocked'), request_code: requestCodeSchema }),
]);
export type RegisterDeviceResponse = z.infer<typeof registerDeviceResponseSchema>;

// ---------------------------------------------------------------------------
// approve_device_rebind edge function
// ---------------------------------------------------------------------------

export const approveDeviceRebindRequestSchema = z.object({
  request_code: z.string().min(1).max(16),
});
export type ApproveDeviceRebindRequest = z.infer<typeof approveDeviceRebindRequestSchema>;

export const approveDeviceRebindResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('approved'),
    agent_employee_no: z.string(),
    agent_full_name: z.string(),
    device_model: z.string().nullable(),
  }),
  // Deliberately one bucket for "no such code", "expired", and "agent not in
  // your reporting tree" — a probing caller learns nothing from the shape.
  z.object({ status: z.literal('invalid_code') }),
  z.object({ status: z.literal('forbidden') }),
]);
export type ApproveDeviceRebindResponse = z.infer<typeof approveDeviceRebindResponseSchema>;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export const consentRecordSchema = z.object({
  id: z.uuid(),
  agent_id: z.uuid(),
  policy_version: z.string(),
  accepted_at: z.string(),
});
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
