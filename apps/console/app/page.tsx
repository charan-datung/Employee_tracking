import { redirect } from 'next/navigation';
import { currentConsoleUser } from '../lib/supabase';

export const dynamic = 'force-dynamic';

// Route component. The console's only live feature is the pin review queue;
// session review, flag triage and device-rebind approval come later.
export default async function HomePage() {
  const user = await currentConsoleUser();
  redirect(user === null ? '/login' : '/pins');
}
