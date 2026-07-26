export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="anim-drift pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 70% 20%, rgba(196,240,130,0.18), transparent 55%), radial-gradient(ellipse 50% 40% at 15% 80%, rgba(70,120,90,0.35), transparent 50%), linear-gradient(165deg, #0e1412 0%, #15201a 45%, #0b100e 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'160\' height=\'160\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.8\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'0.55\'/%3E%3C/svg%3E")',
        }}
      />

      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col justify-end px-6 pb-16 pt-24 sm:justify-center sm:pb-24 sm:pt-20">
        <p className="anim-rise font-[family-name:var(--font-display)] text-[clamp(4.5rem,18vw,9rem)] font-medium leading-[0.85] tracking-[-0.04em] text-[var(--accent)]">
          Nexus
        </p>
        <div className="anim-pulse-line mt-6 h-px max-w-md bg-gradient-to-r from-[var(--accent)] to-transparent" />
        <p className="anim-rise-delay mt-8 max-w-md text-lg leading-relaxed text-[var(--foreground)]/80 sm:text-xl">
          Orchestrate agentic work across Cursor — tickets, runs, and reports in
          one loop.
        </p>
        <div className="anim-rise-delay mt-10 flex flex-wrap gap-4">
          <a
            href="/api/health"
            className="bg-[var(--accent)] px-5 py-3 text-sm font-medium tracking-wide text-[var(--ink)] transition hover:brightness-110"
          >
            Health
          </a>
        </div>
      </div>
    </main>
  );
}
