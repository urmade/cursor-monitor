import * as React from 'react';
import { cn } from '../lib/cn';

export function Field({
  className,
  label,
  hint,
  error,
  id: idProp,
  children,
}: {
  className?: string;
  label?: string;
  hint?: string;
  error?: string;
  /** Associates the label with the control; auto-generated when omitted. */
  id?: string;
  children: React.ReactNode;
}) {
  const autoId = React.useId();
  const controlId = idProp ?? autoId;
  const child = React.Children.only(children);
  const control =
    React.isValidElement(child) && child.props
      ? React.cloneElement(child as React.ReactElement<{ id?: string }>, {
          id: (child.props as { id?: string }).id ?? controlId,
        })
      : children;

  return (
    <div className={cn('grid gap-1', className)}>
      {label ? (
        <label htmlFor={controlId} className="text-xs text-fg-muted">
          {label}
        </label>
      ) : null}
      {control}
      {error ? (
        <span className="text-xs text-danger-fg">{error}</span>
      ) : hint ? (
        <span className="text-xs text-fg-subtle">{hint}</span>
      ) : null}
    </div>
  );
}
