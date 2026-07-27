import Link from 'next/link';
import { describeUser } from '../../src/server/identity';
import { optionalSession } from '../../src/server/session';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await optionalSession();

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="border-b border-white/10 bg-black/20 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link
              href="/projects"
              className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[var(--accent)]"
            >
              Nexus
            </Link>
            <nav className="flex gap-4 text-sm text-white/70">
              <Link href="/projects" className="hover:text-white">
                Projects
              </Link>
            </nav>
          </div>
          <div className="text-right text-xs text-white/60">
            {session ? (
              <>
                <div className="text-sm text-white/90">
                  {session.user.name ?? session.user.email ?? 'Signed in'}
                </div>
                <div className="font-mono">
                  {String(describeUser(session.user).external_sub)}
                </div>
              </>
            ) : (
              <span>Not signed in</span>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </div>
  );
}
