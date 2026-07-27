import Link from 'next/link';
import { Button } from '@nexus/ui';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-medium tracking-tight text-fg">Nexus</h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          System of record for agentic work — projects, tickets, specs, and an
          auditable pipeline.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link href="/projects">Open projects</Link>
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/api/health">Health</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
