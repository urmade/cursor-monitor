'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@nexus/ui';
import {
  PROJECT_NAV_ITEMS,
  matchProjectSection,
  projectSectionHref,
} from '../navigation/project-nav';

export function ProjectTabNav({ projectKey }: { projectKey: string }) {
  const pathname = usePathname();
  const active = matchProjectSection(pathname);

  return (
    <nav
      className="mt-3 flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:thin]"
      aria-label="Project sections"
    >
      {PROJECT_NAV_ITEMS.map((tab) => {
        const href = projectSectionHref(projectKey, tab.slug);
        const isActive = active === tab.slug;
        return (
          <Link
            key={tab.slug}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'shrink-0 rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-[var(--nx-hover)] hover:text-fg',
              isActive && 'bg-[var(--nx-selected)] font-medium text-fg',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
