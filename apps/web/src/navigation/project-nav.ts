export type ProjectNavSlug =
  | 'board'
  | 'policies'
  | 'analytics'
  | 'questions'
  | 'settings'
  | 'audit'
  | 'spend';

export type ProjectNavItem = {
  slug: ProjectNavSlug;
  label: string;
  /** Breadcrumb segment when this section is active */
  breadcrumbLabel: string;
};

export const PROJECT_NAV_ITEMS: readonly ProjectNavItem[] = [
  { slug: 'board', label: 'Board', breadcrumbLabel: 'Board' },
  { slug: 'policies', label: 'Policies', breadcrumbLabel: 'Policies' },
  { slug: 'analytics', label: 'Analytics', breadcrumbLabel: 'Analytics' },
  { slug: 'questions', label: 'Questions', breadcrumbLabel: 'Questions' },
  { slug: 'settings', label: 'Settings', breadcrumbLabel: 'Settings' },
  { slug: 'audit', label: 'Audit', breadcrumbLabel: 'Audit' },
  { slug: 'spend', label: 'Spend', breadcrumbLabel: 'Spend' },
] as const;

export function projectSectionHref(projectKey: string, slug: ProjectNavSlug): string {
  return `/projects/${projectKey}/${slug}`;
}

/** Longest matching project section for pathname (excludes item detail). */
export function matchProjectSection(pathname: string): ProjectNavSlug | null {
  const m = pathname.match(/^\/projects\/[^/]+\/([^/]+)/);
  if (!m) return null;
  const segment = m[1];
  if (segment === 'items') return null;
  const found = PROJECT_NAV_ITEMS.find((i) => i.slug === segment);
  return found?.slug ?? null;
}

export function projectBreadcrumbTrail(
  pathname: string,
  projectKey: string,
): Array<{ label: string; href?: string }> {
  const items: Array<{ label: string; href?: string }> = [
    { label: 'Nexus', href: '/projects' },
    { label: projectKey, href: projectSectionHref(projectKey, 'board') },
  ];

  const itemMatch = pathname.match(/\/items\/([^/]+)/);
  if (itemMatch) {
    items.push({ label: 'Board', href: projectSectionHref(projectKey, 'board') });
    items.push({ label: itemMatch[1]! });
    return items;
  }

  const section = matchProjectSection(pathname);
  if (section) {
    const meta = PROJECT_NAV_ITEMS.find((i) => i.slug === section);
    items.push({ label: meta?.breadcrumbLabel ?? section });
    return items;
  }

  items.push({ label: 'Board' });
  return items;
}

export function globalBreadcrumbTrail(pathname: string): Array<{ label: string; href?: string }> {
  const items: Array<{ label: string; href?: string }> = [{ label: 'Nexus', href: '/projects' }];
  if (pathname.startsWith('/inbox')) {
    items.push({ label: 'Inbox' });
  } else if (pathname.startsWith('/projects')) {
    items.push({ label: 'Projects' });
  } else if (pathname.startsWith('/design')) {
    items.push({ label: 'Design' });
  }
  return items;
}
