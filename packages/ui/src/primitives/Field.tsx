import * as React from 'react';
import { cn } from '../lib/cn';

export function Field({
  className,
  label,
  hint,
  error,
  children,
}: {
  className?: string;
  label?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-1', className)}>
      {label ? (
        <span className="text-xs text-fg-muted">{label}</span>
      ) : null}
      {children}
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs text-fg-subtle">{hint}</span>
      ) : null}
    </div>
  );
}
