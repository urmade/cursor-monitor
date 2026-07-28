import { redirect } from 'next/navigation';
import { createFlagReader } from '@nexus/core';
import { getDb } from '@nexus/db';
import { optionalSession } from '../src/server/session';

export default async function Home() {
  const session = await optionalSession();
  if (session) {
    const flags = createFlagReader(getDb());
    if (await flags.isEnabled('p6.inbox')) {
      redirect('/inbox');
    }
    redirect('/projects');
  }
  redirect('/projects');
}
