import * as React from 'react';
import { cn } from '../lib/cn';

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-[var(--nx-control-md)] w-full rounded-md border border-border bg-surface px-2.5 text-sm text-fg',
        'placeholder:text-fg-subtle',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
