'use client';

import * as React from 'react';
import { Kbd } from '../primitives/Kbd';
import { TooltipProvider } from '../primitives/Tooltip';
import {
  CommandPalette,
  useCommandPaletteShortcut,
} from './CommandPalette';
import { Sidebar, type SidebarNavItem, type SidebarProject } from './Sidebar';
import { StatusBar, type StatusBarHealth } from './StatusBar';

const SIDEBAR_COLLAPSED_KEY = 'nexus.sidebarCollapsed';

export type AppShellProps = {
  children: React.ReactNode;
  projects: SidebarProject[];
  projectKey?: string;
  navItems?: SidebarNavItem[];
  currentPath: string;
  breadcrumbs?: React.ReactNode;
  health?: StatusBarHealth | null;
  userLabel?: string;
  onNavigate: (href: string) => void;
};

export function AppShell({
  children,
  projects,
  projectKey,
  navItems,
  currentPath,
  breadcrumbs,
  health,
  userLabel,
  onNavigate,
}: AppShellProps) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (v === '1') setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  const onToggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useCommandPaletteShortcut(() => setPaletteOpen(true));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-canvas text-fg">
        <header
          className="flex h-[var(--nx-title-bar)] shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-3"
        >
          <div className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
            {breadcrumbs}
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2 py-1 text-xs text-fg-muted hover:bg-[var(--nx-hover)]"
          >
            Search
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar
            projects={projects}
            projectKey={projectKey}
            navItems={navItems}
            currentPath={currentPath}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
          <main className="min-w-0 flex-1 overflow-auto">{children}</main>
        </div>
        <StatusBar
          health={health}
          userLabel={userLabel}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          projects={projects}
          projectKey={projectKey}
          onNavigate={onNavigate}
        />
      </div>
    </TooltipProvider>
  );
}

export function Breadcrumb({
  items,
}: {
  items: Array<{ label: string; href?: string }>;
}) {
  return (
    <nav className="flex items-center gap-1.5 truncate">
      {items.map((item, i) => (
        <React.Fragment key={`${item.label}-${i}`}>
          {i > 0 ? <span className="text-fg-subtle">/</span> : null}
          {item.href ? (
            <a
              href={item.href}
              className="hover:text-fg truncate max-w-[10rem]"
            >
              {item.label}
            </a>
          ) : (
            <span className="truncate max-w-[10rem] text-fg">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
