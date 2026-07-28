'use client';

import { useRouter, usePathname } from 'next/navigation';
import {
  AppShell,
  Breadcrumb,
  type SidebarNavItem,
  type SidebarProject,
  type StatusBarHealth,
} from '@nexus/ui';

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
        {
          slug: 'board',
          label: 'Board',
          href: `/projects/${projectKey}/board`,
        },
        {
          slug: 'settings',
          label: 'Settings',
          href: `/projects/${projectKey}/settings`,
        },
        {
          slug: 'audit',
          label: 'Audit',
          href: `/projects/${projectKey}/audit`,
        },
      ]
    : [
        {
          slug: 'inbox',
          label: 'Inbox',
          href: '/inbox',
        },
        {
          slug: 'projects',
          label: 'Projects',
          href: '/projects',
        },
      ];

  const breadcrumbItems: Array<{ label: string; href?: string }> = [
    { label: 'Nexus', href: '/projects' },
  ];
  if (projectKey) {
    breadcrumbItems.push({
      label: projectKey,
      href: `/projects/${projectKey}/board`,
    });
    if (pathname.includes('/settings')) {
      breadcrumbItems.push({ label: 'Settings' });
    } else if (pathname.includes('/audit')) {
      breadcrumbItems.push({ label: 'Audit' });
    } else if (pathname.includes('/items/')) {
      const itemKey = pathname.split('/items/')[1]?.split('/')[0];
      breadcrumbItems.push({ label: 'Board', href: `/projects/${projectKey}/board` });
      if (itemKey) breadcrumbItems.push({ label: itemKey });
    } else {
      breadcrumbItems.push({ label: 'Board' });
    }
  } else if (pathname.startsWith('/inbox')) {
    breadcrumbItems.push({ label: 'Inbox' });
  } else if (pathname.startsWith('/projects')) {
    breadcrumbItems.push({ label: 'Projects' });
  } else if (pathname.startsWith('/design')) {
    breadcrumbItems.push({ label: 'Design' });
  }

  return (
    <AppShell
      projects={projects}
      projectKey={projectKey}
      navItems={navItems}
      currentPath={pathname}
      breadcrumbs={<Breadcrumb items={breadcrumbItems} />}
      health={health}
      userLabel={userLabel}
      onNavigate={(href) => router.push(href)}
    >
      {children}
    </AppShell>
  );
}
