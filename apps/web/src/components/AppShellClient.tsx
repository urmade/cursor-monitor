'use client';

import { useRouter, usePathname } from 'next/navigation';
import {
  AppShell,
  Breadcrumb,
  type SidebarNavItem,
  type SidebarProject,
  type StatusBarHealth,
} from '@nexus/ui';
import {
  PROJECT_NAV_ITEMS,
  globalBreadcrumbTrail,
  projectBreadcrumbTrail,
  projectSectionHref,
} from '../navigation/project-nav';

function projectKeyFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m?.[1];
}

export function AppShellClient({
  children,
  projects,
  health,
  userLabel,
}: {
  children: React.ReactNode;
  projects: SidebarProject[];
  health?: StatusBarHealth | null;
  userLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const projectKey = projectKeyFromPath(pathname);

  const navItems: SidebarNavItem[] | undefined = projectKey
    ? [
        { slug: 'inbox', label: 'Inbox', href: '/inbox' },
        ...PROJECT_NAV_ITEMS.map((item) => ({
          slug: item.slug,
          label: item.label,
          href: projectSectionHref(projectKey, item.slug),
        })),
      ]
    : [
        { slug: 'inbox', label: 'Inbox', href: '/inbox' },
        { slug: 'projects', label: 'Projects', href: '/projects' },
        { slug: 'monitoring', label: 'Monitoring', href: '/monitoring' },
      ];

  const breadcrumbItems = projectKey
    ? projectBreadcrumbTrail(pathname, projectKey)
    : globalBreadcrumbTrail(pathname);

  const commandNavItems = projectKey
    ? [
        { label: 'Inbox', href: '/inbox' },
        ...PROJECT_NAV_ITEMS.map((item) => ({
          label: `${item.label} (${projectKey})`,
          href: projectSectionHref(projectKey, item.slug),
        })),
      ]
    : [
        { label: 'Inbox', href: '/inbox' },
        { label: 'Monitoring', href: '/monitoring' },
      ];

  return (
    <AppShell
      projects={projects}
      projectKey={projectKey}
      navItems={navItems}
      currentPath={pathname}
      breadcrumbs={<Breadcrumb items={breadcrumbItems} />}
      health={health}
      userLabel={userLabel}
      commandNavItems={commandNavItems}
      onNavigate={(href) => router.push(href)}
    >
      {children}
    </AppShell>
  );
}
