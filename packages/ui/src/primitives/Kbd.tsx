import * as React from 'react';
import { cn } from '../lib/cn';

export function Kbd({
  className,
  ...props
}: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex min-h-5 items-center rounded border border-border bg-surface-sunken px-1.5 font-mono text-[10px] text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}
