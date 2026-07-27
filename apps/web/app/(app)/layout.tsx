import { listProjects } from '@nexus/core';
import { AppShellClient } from '../../src/components/AppShellClient';
import { describeUser } from '../../src/server/identity';
import { optionalSession } from '../../src/server/session';
import { getHealthSnapshot } from '../../src/server/health';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await optionalSession();
  const health = await getHealthSnapshot();

  let projects: { key: string; name: string }[] = [];
  if (session) {
    const result = await listProjects(session.ctx);
    if (result.ok) {
      projects = result.value.map((p) => ({ key: p.key, name: p.name }));
    }
  }

  const userLabel = session
    ? (session.user.name ??
      session.user.email ??
      String(describeUser(session.user).external_sub))
    : 'Not signed in';

  return (
    <AppShellClient
      projects={projects}
      health={health}
      userLabel={userLabel}
    >
      {children}
    </AppShellClient>
  );
}
