'use client';

import { Command } from 'cmdk';
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../primitives/Dialog';
import { useTheme } from '../theme/ThemeProvider';
import type { SidebarProject } from './Sidebar';

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: SidebarProject[];
  projectKey?: string;
  onNavigate: (href: string) => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  projectKey,
  onNavigate,
}: CommandPaletteProps) {
  const { toggle } = useTheme();

  const run = (href: string) => {
    onOpenChange(false);
    onNavigate(href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] max-w-xl p-0" showClose={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command className="rounded-lg">
          <Command.Input
            placeholder="Type a command or search…"
            className="h-11 w-full border-b border-border bg-transparent px-3 text-sm outline-none"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-fg-muted">
              No results.
            </Command.Empty>
            <Command.Group heading="Navigation">
              <Command.Item
                onSelect={() => run('/projects')}
                className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
              >
                Projects
              </Command.Item>
              {projectKey ? (
                <>
                  <Command.Item
                    onSelect={() => run(`/projects/${projectKey}/board`)}
                    className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
                  >
                    Board ({projectKey})
                  </Command.Item>
                  <Command.Item
                    onSelect={() => run(`/projects/${projectKey}/settings`)}
                    className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
                  >
                    Settings ({projectKey})
                  </Command.Item>
                  <Command.Item
                    onSelect={() => run(`/projects/${projectKey}/audit`)}
                    className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
                  >
                    Audit ({projectKey})
                  </Command.Item>
                </>
              ) : null}
            </Command.Group>
            <Command.Group heading="Projects">
              {projects.map((p) => (
                <Command.Item
                  key={p.key}
                  onSelect={() => run(`/projects/${p.key}/board`)}
                  className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
                >
                  <span className="font-mono text-xs">{p.key}</span>
                  <span className="ml-2">{p.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
            <Command.Group heading="Actions">
              <Command.Item
                onSelect={() => {
                  onOpenChange(false);
                  toggle();
                }}
                className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
              >
                Toggle theme
              </Command.Item>
              <Command.Item
                onSelect={() => run('/design')}
                className="rounded-md px-2 py-1.5 text-sm aria-selected:bg-[var(--nx-hover)]"
              >
                Design system
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function useCommandPaletteShortcut(onOpen: () => void) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}
