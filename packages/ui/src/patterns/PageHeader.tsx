import * as React from 'react';
import { cn } from '../lib/cn';

export function PageHeader({
  title,
  subtitle,
  meta,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4',
        className,
      )}
    >
      <div className="min-w-0">
        {meta ? (
          <div className="mb-1 font-mono text-xs text-fg-muted">{meta}</div>
        ) : null}
        <h1 className="text-xl font-medium tracking-tight text-fg">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
