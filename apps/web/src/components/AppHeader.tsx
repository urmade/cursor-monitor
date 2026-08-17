import Link from 'next/link';

export function AppHeader() {
  return (
    <header className="app-header">
      <Link className="brand" href="/">
        <span className="brand-mark" aria-hidden>
          CM
        </span>
        <span>
          <strong>Cursor Monitor</strong>
          <small>Team request telemetry</small>
        </span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/">Repositories</Link>
        <Link href="/install">Install hooks</Link>
        <Link href="/settings">Operations</Link>
        <a href="/api/health">Health</a>
      </nav>
    </header>
  );
}
