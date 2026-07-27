import * as React from 'react';
import { cn } from '../lib/cn';

export function Toolbar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
