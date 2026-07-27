'use client';

import * as React from 'react';
import { cn } from '../lib/cn';
import { Kbd } from '../primitives/Kbd';
import { ThemeToggle } from './ThemeToggle';

export type StatusBarHealth = {
  db: string;
  migrationVersion?: string | number;
};

export function StatusBar({
  health,
  userLabel,
  onOpenCommandPalette,
  className,
}: {
  health?: StatusBarHealth | null;
  userLabel?: string;
  onOpenCommandPalette?: () => void;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        'flex h-[var(--nx-status-bar)] shrink-0 items-center justify-between gap-4 border-t border-border bg-surface-sunken px-3 text-[11px] text-fg-muted',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {health ? (
          <>
            <span>
              DB:{' '}
              <span className="font-mono text-fg">{health.db}</span>
            </span>
            {health.migrationVersion != null ? (
              <span>
                mig{' '}
                <span className="font-mono text-fg">
                  {String(health.migrationVersion)}
                </span>
              </span>
            ) : null}
          </>
        ) : (
          <span>Loading health…</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {userLabel ? <span className="truncate max-w-[12rem]">{userLabel}</span> : null}
        <ThemeToggle />
        {onOpenCommandPalette ? (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="flex items-center gap-1 rounded-sm px-1 hover:bg-[var(--nx-hover)]"
          >
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </button>
        ) : null}
      </div>
    </footer>
  );
}
