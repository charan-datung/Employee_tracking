import { useState } from 'react';
import {
  OFFLINE_GRACE_HOURS,
  PRIVACY_POLICY_VERSION,
  RETENTION_ATTENDANCE_RECORDS_YEARS,
  RETENTION_RAW_LOCATION_DAYS,
} from '@datung/shared';
import { useAuth } from '../features/auth/AuthProvider';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      <div className="mt-2 space-y-2 text-[15px] leading-relaxed text-gray-700">
        {children}
      </div>
    </section>
  );
}

// Route component. RA 10173 consent gate — full screen, not dismissible, the
// app is unusable until "Sumasang-ayon ako" is tapped. Bumping
// PRIVACY_POLICY_VERSION in @datung/shared re-triggers this for everyone.
export function ConsentPage() {
  const { acceptConsent, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onAccept = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await acceptConsent();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <div className="flex-1 overflow-y-auto px-6 pb-6 pt-12">
        <div className="mx-auto max-w-md">
          <h1 className="text-2xl font-bold text-gray-900">
            Pahintulot sa Datos
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Data Privacy Notice · Bersyon {PRIVACY_POLICY_VERSION}
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-gray-700">
            Bago mo magamit ang Datung Field, basahin at unawain kung paano
            namin ginagamit ang datos mo, alinsunod sa Data Privacy Act of 2012
            (RA 10173).
          </p>

          {/* KAILAN — the single most important fact, stated prominently. */}
          <div className="mt-6 rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-4">
            <h2 className="text-base font-bold text-emerald-900">
              KAILAN ka namin sinusubaybayan
            </h2>
            <p className="mt-2 text-[15px] font-medium leading-relaxed text-emerald-900">
              Sa pagitan lang ng <span className="font-bold">check-in</span> at{' '}
              <span className="font-bold">check-out</span> mo. Kapag naka-check-out
              ka, <span className="font-bold">HINDI namin nakikita ang lokasyon
              mo</span> — walang tracking pagkatapos ng trabaho, sa gabi, sa
              weekend, o sa bakasyon. Ganito ang dinisenyo ng app; hindi ito
              kayang i-override ng kahit sino.
            </p>
          </div>

          <Section title="Ano ang kinokolekta namin">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <span className="font-semibold">Lokasyon (GPS)</span> — habang
                naka-check-in ka, para mapatunayan ang attendance at mga visit.
              </li>
              <li>
                <span className="font-semibold">Selfie</span> — sa check-in,
                check-out, at mga visit, para makumpirma na ikaw talaga ito.
              </li>
              <li>
                <span className="font-semibold">Device ID</span> — para matiyak
                na sa registered na phone mo lang ginagamit ang account mo.
              </li>
              <li>
                <span className="font-semibold">Baterya at signal</span> — para
                maintindihan kung bakit may mga putol sa datos.
              </li>
            </ul>
          </Section>

          <Section title="Bakit namin ito kinokolekta">
            <p>
              Patunay ng attendance at field visits, proteksyon laban sa
              pandaraya, at kaligtasan mo habang nasa field. Wala kaming
              kinokolektang datos tungkol sa pera — nasa ibang sistema iyon.
            </p>
          </Section>

          <Section title="Gaano katagal itatago">
            <p>
              Ang detalyadong GPS trail ay itinatago nang{' '}
              <span className="font-semibold">
                {RETENTION_RAW_LOCATION_DAYS} araw
              </span>{' '}
              at pagkatapos ay buod (summary) na lang ang naiiwan. Ang
              attendance at visit records ay itinatago nang{' '}
              <span className="font-semibold">
                {RETENTION_ATTENDANCE_RECORDS_YEARS} taon
              </span>{' '}
              ayon sa patakaran ng kumpanya at ng batas.
            </p>
          </Section>

          <Section title="Sino ang makakakita">
            <p>
              Ang supervisor mo at ang awtorisadong HR/management ng kumpanya
              lang. Hindi ibinebenta o ibinabahagi sa labas ang datos mo.
            </p>
          </Section>

          <Section title="Mga karapatan mo sa ilalim ng RA 10173">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Makita ang sariling datos (right to access).</li>
              <li>Ipa-tama ang maling datos (right to correction).</li>
              <li>
                Magreklamo sa{' '}
                <span className="font-semibold">
                  National Privacy Commission
                </span>{' '}
                (privacy.gov.ph) kung sa tingin mo ay nilabag ang karapatan mo.
              </li>
              <li>
                Makipag-ugnayan sa Data Protection Officer ng kumpanya para sa
                anumang tanong tungkol sa datos mo.
              </li>
            </ul>
          </Section>

          <p className="mt-6 text-sm text-gray-500">
            Kung offline ka nang hindi hihigit sa {OFFLINE_GRACE_HOURS} na oras,
            gagana pa rin ang app; kailangan lang nitong maka-online paminsan-
            minsan para ma-sync ang datos.
          </p>
        </div>
      </div>

      <div className="border-t border-gray-200 px-6 py-4">
        <div className="mx-auto max-w-md space-y-3">
          {failed && (
            <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              Hindi na-save ang pahintulot. Siguraduhing may internet at
              subukan ulit.
            </p>
          )}
          <button
            type="button"
            onClick={() => void onAccept()}
            disabled={busy}
            className="h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white active:bg-emerald-700 disabled:bg-gray-300"
          >
            {busy ? 'Sine-save…' : 'Sumasang-ayon ako'}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="h-12 w-full rounded-xl text-base font-medium text-gray-500 active:bg-gray-100"
          >
            Hindi ako sumasang-ayon (mag-logout)
          </button>
        </div>
      </div>
    </main>
  );
}
