import { getProjectByKey } from '@nexus/core';
import { PageHeader } from '@nexus/ui';
import { notFound } from 'next/navigation';
import { ProjectTabNav } from '../../../../src/components/ProjectTabNav';
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

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-surface px-4 py-3">
        <PageHeader
          meta={project.value.key}
          title={project.value.name}
          subtitle={project.value.description}
        />
        <ProjectTabNav projectKey={projectKey} />
      </div>
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}
