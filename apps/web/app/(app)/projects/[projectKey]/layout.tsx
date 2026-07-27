import Link from 'next/link';
import { getProjectByKey } from '@nexus/core';
import { PageHeader } from '@nexus/ui';
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

  const tabs = [
    { slug: 'board', label: 'Board', href: `/projects/${projectKey}/board` },
    { slug: 'settings', label: 'Settings', href: `/projects/${projectKey}/settings` },
    { slug: 'audit', label: 'Audit', href: `/projects/${projectKey}/audit` },
  ] as const;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-surface px-4 py-3">
        <PageHeader
          meta={project.value.key}
          title={project.value.name}
          subtitle={project.value.description}
        />
        <nav className="mt-3 flex gap-1">
          {tabs.map((tab) => (
            <Link
              key={tab.slug}
              href={tab.href}
              className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-[var(--nx-hover)] hover:text-fg"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}
