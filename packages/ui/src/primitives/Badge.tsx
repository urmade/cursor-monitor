import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../lib/cn';

export const badgeTones = [
  'neutral',
  'success',
  'warning',
  'danger',
  'info',
  'active',
  'blocked',
  'archived',
  'low',
  'medium',
  'high',
  'forward',
  'backward',
  'human',
  'agent',
] as const;

export type BadgeTone = (typeof badgeTones)[number];

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-surface-sunken text-fg-muted',
        success:
          'border-success-border bg-success-bg text-success-fg',
        warning:
          'border-warning-border bg-warning-bg text-warning-fg',
        danger: 'border-danger-border bg-danger-bg text-danger-fg',
        info: 'border-info-border bg-info-bg text-info-fg',
        active: 'border-success-border bg-success-bg text-success-fg',
        blocked: 'border-warning-border bg-warning-bg text-warning-fg',
        archived: 'border-border bg-surface-sunken text-fg-subtle',
        low: 'border-info-border bg-info-bg text-info-fg',
        medium: 'border-warning-border bg-warning-bg text-warning-fg',
        high: 'border-danger-border bg-danger-bg text-danger-fg',
        forward: 'border-info-border bg-info-bg text-info-fg',
        backward: 'border-warning-border bg-warning-bg text-warning-fg',
        human: 'border-border bg-surface-sunken text-fg-muted',
        agent: 'border-info-border bg-info-bg text-info-fg',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export type BadgeProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, className }))} {...props} />
  );
}

export function StatusDot({
  tone = 'neutral',
  className,
}: {
  tone?: BadgeTone;
  className?: string;
}) {
  const color =
    tone === 'success' || tone === 'active'
      ? 'bg-success'
      : tone === 'warning' || tone === 'blocked'
        ? 'bg-warning'
        : tone === 'danger' || tone === 'high'
          ? 'bg-danger'
          : tone === 'info' || tone === 'forward'
            ? 'bg-info'
            : 'bg-fg-subtle';
  return (
    <span
      className={cn('inline-block size-1.5 rounded-full', color, className)}
      aria-hidden
    />
  );
}

export function statusToTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'active';
    case 'externally_blocked':
      return 'blocked';
    case 'archived':
      return 'archived';
    default:
      return 'neutral';
  }
}

export function complexityToTone(
  complexity: string | null | undefined,
): BadgeTone {
  switch (complexity) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return 'neutral';
  }
}
