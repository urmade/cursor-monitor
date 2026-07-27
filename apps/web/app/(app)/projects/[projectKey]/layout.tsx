import Link from 'next/link';
import { getProjectByKey } from '@nexus/core';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../src/server/session';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const { ctx } = await requireSession();
  const project = await getProjectByKey(ctx, projectKey);
  if (!project.ok) notFound();

  const links = [
    ['board', 'Board'],
    ['settings', 'Settings'],
    ['audit', 'Audit'],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-mono text-[var(--accent)]">
            {project.value.key}
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight">
            {project.value.name}
          </h1>
        </div>
        <nav className="flex gap-1 text-sm">
          {links.map(([slug, label]) => (
            <Link
              key={slug}
              href={`/projects/${projectKey}/${slug}`}
              className="px-3 py-1.5 text-white/65 hover:bg-white/5 hover:text-white"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
