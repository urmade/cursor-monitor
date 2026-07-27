import * as React from 'react';
import { cn } from '../lib/cn';

export function PropertyRow({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1 py-2', className)}>
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="text-sm text-fg">{value}</div>
    </div>
  );
}

export function DataList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ul className={cn('divide-y divide-border border border-border rounded-md', className)}>
      {children}
    </ul>
  );
}

export function DataListItem({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li className={cn('px-3 py-2 text-sm', className)}>{children}</li>
  );
}
