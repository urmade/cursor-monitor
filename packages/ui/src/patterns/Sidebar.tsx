'use client';

import { ChevronDown, FolderKanban } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../primitives/DropdownMenu';

export type SidebarProject = { key: string; name: string };

export type SidebarNavItem = {
  slug: string;
  label: string;
  href: string;
};

export function Sidebar({
  projects,
  projectKey,
  navItems,
  currentPath,
  collapsed,
  onToggleCollapsed,
}: {
  projects: SidebarProject[];
  projectKey?: string;
  navItems?: SidebarNavItem[];
  currentPath: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const current = projects.find((p) => p.key === projectKey);

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-surface-sunken transition-[width]',
        collapsed ? 'w-12' : 'w-[var(--nx-sidebar-width)]',
      )}
    >
      <div
        className="flex h-[var(--nx-title-bar)] items-center border-b border-border px-2"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-[var(--nx-hover)] hover:text-fg"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <FolderKanban className="size-4" />
        </button>
        {!collapsed ? (
          <span className="ml-1 text-sm font-medium text-fg">Nexus</span>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-[var(--nx-sidebar-row)] w-full items-center justify-between gap-2 rounded-md px-2 text-sm text-fg hover:bg-[var(--nx-hover)]"
              >
                <span className="truncate font-mono text-xs">
                  {current?.key ?? 'Projects'}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem asChild>
                <a href="/projects">All projects</a>
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.key} asChild>
                  <a href={`/projects/${p.key}/board`}>
                    <span className="font-mono text-xs">{p.key}</span>
                    <span className="ml-2 truncate">{p.name}</span>
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {navItems && !collapsed ? (
        <nav className="flex-1 px-2">
          {navItems.map((item) => {
            const active =
              currentPath === item.href ||
              currentPath.startsWith(item.href + '/');
            return (
              <a
                key={item.slug}
                href={item.href}
                className={cn(
                  'relative flex h-[var(--nx-sidebar-row)] items-center rounded-md px-2 text-sm text-fg-muted hover:bg-[var(--nx-hover)] hover:text-fg',
                  active && 'bg-[var(--nx-selected)] text-fg',
                )}
              >
                {active ? (
                  <span
                    className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-link"
                    aria-hidden
                  />
                ) : null}
                {item.label}
              </a>
            );
          })}
        </nav>
      ) : null}
    </aside>
  );
}
