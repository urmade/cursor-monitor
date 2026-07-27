import * as React from 'react';
import { cn } from '../lib/cn';

export function Panel({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-surface',
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-b border-border px-3 py-2',
        className,
      )}
      {...props}
    />
  );
}

export function PanelBody({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return <div className={cn('p-3', className)} {...props} />;
}
