import { requireConsoleUser, userClient } from '../lib/supabase';
import { BoardTable, type BoardRow } from './BoardTable';

export const dynamic = 'force-dynamic';

// Today's board — the screen a supervisor opens every morning.
export default async function BoardPage() {
  await requireConsoleUser();

  // Read AS THE SUPERVISOR: supervisor_board() resolves the reporting tree
  // from auth.uid() server-side, so there is no tree parameter to tamper with.
  const supabase = await userClient();
  const { data } = await supabase.rpc('supervisor_board');
  const rows = (data ?? []) as BoardRow[];

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Ngayong araw</h1>
      <p className="mt-1 text-sm text-gray-500">
        Live board ng lahat ng ahente sa ilalim mo.
      </p>
      <div className="mt-6">
        <BoardTable initialRows={rows} />
      </div>
    </main>
  );
}
