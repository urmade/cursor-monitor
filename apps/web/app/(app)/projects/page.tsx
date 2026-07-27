import Link from 'next/link';
import { listProjects } from '@nexus/core';
import {
  EmptyState,
  Panel,
  PanelBody,
} from '@nexus/ui';
import { CreateProjectDialog } from '../../../src/components/CreateProjectDialog';
import { requireSession } from '../../../src/server/session';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const { ctx } = await requireSession();
  const projects = await listProjects(ctx);
  const rows = projects.ok ? projects.value : [];

  return (
    <div className="space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium text-fg">Projects</h1>
          <p className="mt-1 max-w-xl text-sm text-fg-muted">
            Each project owns its pipeline and label taxonomy. Nothing is
            hardcoded to a single shape.
          </p>
        </div>
        <CreateProjectDialog />
      </div>

      <Panel>
        <PanelBody className="p-0">
          {rows.length === 0 ? (
            <EmptyState
              title="No projects yet"
              description="Create one to get started."
              action={<CreateProjectDialog />}
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.key}/board`}
                    className="flex items-baseline justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--nx-hover)]"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-fg-muted">{p.key}</div>
                      <div className="text-sm font-medium text-fg">{p.name}</div>
                      {p.description ? (
                        <div className="mt-0.5 text-xs text-fg-subtle">
                          {p.description}
                        </div>
                      ) : null}
                    </div>
                    <span className="text-xs text-fg-subtle">Board →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
