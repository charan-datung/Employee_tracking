// Temporary passwords for provisioning and resets.
//
// These get READ OVER THE PHONE to someone standing in the field, so they
// avoid characters that sound alike or look alike in a hurry: no O/0, no
// I/1/l, no S/5. Length and the mixed alphabet keep it well past Supabase's
// minimum while staying dictatable in one breath.
//
// This is a FIRST-LOGIN credential. The agent should change it — and until
// they do, the account is only as private as the phone call was.
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ';
const DIGITS = '23456789';

export function generateTempPassword(): string {
  const pick = (chars: string, n: number): string => {
    const bytes = new Uint32Array(n);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => chars[b % chars.length]).join('');
  };
  // e.g. "Datung-KMQP-4783"
  return `Datung-${pick(ALPHABET, 4)}-${pick(DIGITS, 4)}`;
}
