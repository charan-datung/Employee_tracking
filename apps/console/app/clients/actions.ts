'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { adminClient, currentConsoleUser } from '../../lib/supabase';
import { nominatimGeocoder } from '../../lib/geocoder';

// CSV bulk import.
//
// Rows arrive parsed from the browser (the file never leaves it as a file).
// Every row is validated, then geocoded ONLY if it has no coordinates. A row
// that cannot be geocoded is still imported, as 'unverified' — it lands in
// the pin-review queue instead of being rejected, because a client who exists
// must be visitable even if a robot could not find their street.

const rowSchema = z.object({
  external_ref: z.string().trim().max(64).nullable(),
  display_name: z.string().trim().min(1).max(200),
  account_type: z.enum(['coco_martin_group', 'trust_loan_sme']),
  address_text: z.string().trim().max(400).nullable(),
  barangay: z.string().trim().max(120).nullable(),
  city: z.string().trim().max(120).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  assigned_employee_no: z.string().trim().max(32).nullable(),
});

const importSchema = z.object({ rows: z.array(rowSchema).min(1).max(2000) });

export interface ImportReport {
  status: 'ok' | 'forbidden' | 'invalid';
  message?: string;
  inserted: number;
  geocoded: number;
  unverified: number;
  failedRows: { row: number; reason: string }[];
  geocoderAvailable: boolean;
}

export async function importClientsAction(input: unknown): Promise<ImportReport> {
  const empty = {
    inserted: 0, geocoded: 0, unverified: 0, failedRows: [],
    geocoderAvailable: nominatimGeocoder.available,
  };
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'invalid', message: 'Mali ang format ng CSV.', ...empty };
  }
  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden', ...empty };

  const admin = adminClient();
  const { data: agents } = await admin.from('agents').select('id, employee_no');
  const byEmployeeNo = new Map(
    (agents ?? []).map((a) => [String(a.employee_no), String(a.id)]),
  );

  const failedRows: { row: number; reason: string }[] = [];
  const payload: Record<string, unknown>[] = [];
  let geocoded = 0;
  let unverified = 0;

  for (const [index, row] of parsed.data.rows.entries()) {
    let lat = row.lat;
    let lng = row.lng;
    let confidence: 'exact' | 'approximate' | 'unverified' =
      lat !== null && lng !== null ? 'exact' : 'unverified';

    if ((lat === null || lng === null) && nominatimGeocoder.available) {
      const query = [row.address_text, row.barangay, row.city, 'Philippines']
        .filter((p) => p !== null && p !== '')
        .join(', ');
      const hit = query.length > 0 ? await nominatimGeocoder.geocode(query) : null;
      if (hit !== null) {
        lat = hit.lat;
        lng = hit.lng;
        confidence = hit.confidence;
        geocoded += 1;
      }
    }
    if (lat === null || lng === null) {
      confidence = 'unverified';
      unverified += 1;
    }

    let assigned: string | null = null;
    if (row.assigned_employee_no !== null && row.assigned_employee_no !== '') {
      assigned = byEmployeeNo.get(row.assigned_employee_no) ?? null;
      if (assigned === null) {
        failedRows.push({
          row: index + 2,
          reason: `Walang agent na ${row.assigned_employee_no}`,
        });
        continue;
      }
    }

    payload.push({
      external_ref: row.external_ref,
      display_name: row.display_name,
      account_type: row.account_type,
      address_text: row.address_text,
      barangay: row.barangay,
      city: row.city,
      lat, lng,
      geocode_confidence: confidence,
      assigned_agent_id: assigned,
      is_active: true,
    });
  }

  if (payload.length === 0) {
    return {
      status: 'invalid', message: 'Walang na-import na row.',
      ...empty, failedRows,
    };
  }

  // Upsert on external_ref so re-importing a corrected file updates rather
  // than duplicating — Odoo refs are the identity here.
  const { error } = await admin
    .from('clients')
    .upsert(payload, { onConflict: 'external_ref', ignoreDuplicates: false });
  if (error !== null) {
    return {
      status: 'invalid', message: `Hindi na-save: ${error.message}`,
      ...empty, failedRows,
    };
  }

  revalidatePath('/clients');
  return {
    status: 'ok',
    inserted: payload.length,
    geocoded,
    unverified,
    failedRows,
    geocoderAvailable: nominatimGeocoder.available,
  };
}
