import Link from 'next/link';
import { requireConsoleUser, userClient } from '../../lib/supabase';
import { FLAG_LABELS } from '../../lib/format';
import { TriageList, type TriageFlag } from './TriageList';

export const dynamic = 'force-dynamic';

// Triage queue: every open flag in the supervisor's tree. RLS
// (flags_select_reports) does the scoping, so there is no tree filter here to
// get wrong.
export default async function FlagsPage() {
  await requireConsoleUser();
  const supabase = await userClient();

  const { data } = await supabase
    .from('integrity_flags')
    .select(
      'id, flag_type, severity, detail, raised_at, session_id, agent_id, ' +
        'agents(full_name, employee_no)',
    )
    .is('resolved_at', null)
    // Severity first, then age: a week-old critical still outranks a fresh
    // warn, because criticals are the ones that decay into "we never looked".
    .order('severity', { ascending: true })
    .order('raised_at', { ascending: true });

  const flags = (data ?? []) as unknown as TriageFlag[];
  const criticals = flags.filter((f) => f.severity === 'critical').length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Triage queue</h1>
        <p className="mt-1 text-sm text-gray-500">
          {flags.length} bukas na flag · {criticals} critical. Naka-group kada
          ahente.
        </p>
      </header>
      <div className="mt-6">
        <TriageList flags={flags} labels={FLAG_LABELS} />
      </div>
      {flags.length === 0 && (
        <p className="mt-10 rounded-2xl border border-dashed border-gray-300 p-10 text-center text-gray-500">
          Walang bukas na flag. <Link href="/" className="underline">Balik sa board</Link>
        </p>
      )}
    </main>
  );
}
