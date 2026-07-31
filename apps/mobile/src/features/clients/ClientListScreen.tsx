import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GeocodeConfidence } from '@datung/shared';
import { formatDistance } from '../visits/gate.ts';
import { getLastPosition } from './lastPosition.ts';
import { listClients, searchClients, type ClientListItem } from './repo.ts';
import { syncClientsIfStale } from './sync.ts';
import type { Position } from './sql.ts';

const CONFIDENCE_BADGE: Record<GeocodeConfidence, { label: string; className: string }> = {
  exact: { label: 'Tumpak', className: 'bg-emerald-100 text-emerald-800' },
  approximate: { label: 'Tantiya', className: 'bg-amber-100 text-amber-800' },
  unverified: { label: 'Di-beripikado', className: 'bg-gray-200 text-gray-700' },
};

const OUTCOME_SHORT: Record<string, string> = {
  contacted_paid: 'Nagbayad',
  contacted_promised: 'Nangako',
  contacted_refused: 'Ayaw magbayad',
  not_home: 'Wala sa bahay',
  wrong_address: 'Maling address',
  closed_business: 'Sarado',
  client_relocated: 'Lumipat',
  other: 'Iba pa',
};

function lastVisitLabel(item: ClientListItem): string {
  if (item.last_visit_at === null) return 'Wala pang visit';
  const days = Math.floor((Date.now() - item.last_visit_at) / 86_400_000);
  const when =
    days <= 0 ? 'Ngayong araw' : days === 1 ? 'Kahapon' : `${days} araw na nakaraan`;
  const outcome =
    item.last_visit_outcome === null
      ? ''
      : ` · ${OUTCOME_SHORT[item.last_visit_outcome] ?? item.last_visit_outcome}`;
  return `${when}${outcome}`;
}

// The agent's client book. Fully offline: the list, the ordering and the
// search all run against SQLite. Distance ordering is recomputed only when
// the agent pulls to refresh — never on a timer, which would burn battery for
// a list that barely changes as they walk.
export function ClientListScreen() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ClientListItem[]>([]);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (raw: string, pos: Position | null) => {
    const rows =
      raw.trim().length === 0
        ? await listClients(pos)
        : await searchClients(raw, pos);
    setItems(rows);
  }, []);

  useEffect(() => {
    void (async () => {
      const pos = await getLastPosition();
      setPosition(pos);
      // Refresh the book on first open of the day; failures are silent and
      // leave yesterday's book in place.
      void syncClientsIfStale().then(async (r) => {
        if (r.synced) await load(query, pos);
      });
      await load('', pos);
      setLoading(false);
    })();
    // Intentionally once on mount; search re-runs through its own effect.
  }, [load, query]);

  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => void load(query, position), 150);
    return () => clearTimeout(timer);
  }, [query, position, loading, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const pos = await getLastPosition();
      setPosition(pos);
      await syncClientsIfStale({ force: true });
      await load(query, pos);
    } finally {
      setRefreshing(false);
    }
  }, [query, load]);

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white px-5 pb-3 pt-12">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl text-gray-600"
            aria-label="Bumalik"
          >
            ←
          </button>
          <h1 className="text-lg font-bold text-gray-900">Mga Client</h1>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="ml-auto h-11 rounded-xl bg-gray-100 px-4 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            {refreshing ? 'Ina-update…' : 'I-refresh'}
          </button>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hanapin sa pangalan o account ref"
          className="mt-3 h-12 w-full rounded-xl border border-gray-300 px-4 text-base focus:border-emerald-600 focus:outline-none"
        />
      </header>

      <div className="flex-1 px-5 py-4">
        {loading ? (
          <p className="mt-8 text-center text-gray-500">Binubuksan ang listahan…</p>
        ) : items.length === 0 ? (
          <p className="mt-8 text-center text-gray-500">
            {query.trim().length > 0
              ? 'Walang tumugmang client.'
              : 'Wala pang client sa listahan mo. I-refresh kapag may internet.'}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {items.map((item) => {
              const badge = CONFIDENCE_BADGE[item.geocode_confidence];
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/visit/${item.id}`)}
                    className="w-full rounded-2xl bg-white p-4 text-left active:bg-gray-100"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-gray-900">
                          {item.display_name}
                        </p>
                        <p className="mt-0.5 truncate text-sm text-gray-500">
                          {item.barangay ?? item.city ?? '—'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-base font-bold text-gray-900">
                          {item.distance_m === null
                            ? '—'
                            : formatDistance(item.distance_m)}
                        </p>
                        <span
                          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-gray-500">{lastVisitLabel(item)}</p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
