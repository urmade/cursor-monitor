import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Hook signals live in Monitoring (per repository). Keep /hooks as a stable entry. */
export default function HooksSignalsPage() {
  redirect('/monitoring');
}
