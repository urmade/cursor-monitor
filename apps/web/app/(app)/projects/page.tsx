import Link from 'next/link';
import { listProjects } from '@nexus/core';
import { actionCreateProject } from '../../../src/server/actions';
import { requireSession } from '../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const { ctx } = await requireSession();
  const projects = await listProjects(ctx);
  const rows = projects.ok ? projects.value : [];

  return (
    <div className="space-y-10">
      <section>
        <h1 className="font-[family-name:var(--font-display)] text-4xl tracking-tight">
          Projects
        </h1>
        <p className="mt-2 max-w-xl text-white/65">
          Each project owns its pipeline and label taxonomy. Nothing is hardcoded
          to a single shape.
        </p>
      </section>

      <section className="grid gap-3">
        {rows.length === 0 ? (
          <p className="text-white/55">No projects yet. Create one below.</p>
        ) : (
          rows.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.key}/board`}
              className="group flex items-baseline justify-between border border-white/10 bg-white/[0.03] px-4 py-3 transition hover:border-[var(--accent)]/40 hover:bg-white/[0.06]"
            >
              <div>
                <div className="font-mono text-xs text-[var(--accent)]">{p.key}</div>
                <div className="text-lg group-hover:text-white">{p.name}</div>
                {p.description ? (
                  <div className="mt-1 text-sm text-white/50">{p.description}</div>
                ) : null}
              </div>
              <span className="text-sm text-white/40 group-hover:text-[var(--accent)]">
                Board →
              </span>
            </Link>
          ))
        )}
      </section>

      <section className="border border-white/10 bg-white/[0.02] p-5">
        <h2 className="text-lg font-medium">Create project</h2>
        <form action={actionCreateProject} className="mt-4 grid max-w-lg gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-white/60">Key</span>
            <input
              name="key"
              required
              placeholder="ACME"
              className="border border-white/15 bg-black/30 px-3 py-2 font-mono uppercase outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-white/60">Name</span>
            <input
              name="name"
              required
              placeholder="Acme Platform"
              className="border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-white/60">Description</span>
            <textarea
              name="description"
              rows={2}
              className="border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-[var(--accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-white/60">Template</span>
            <select
              name="template"
              defaultValue="default"
              className="border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-[var(--accent)]"
            >
              <option value="default">Default (6 stages)</option>
              <option value="minimal">Minimal (3 stages)</option>
              <option value="empty">Empty</option>
            </select>
          </label>
          <button
            type="submit"
            className="mt-2 w-fit bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--ink)]"
          >
            Create
          </button>
        </form>
      </section>
    </div>
  );
}
