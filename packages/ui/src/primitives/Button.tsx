import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import * as React from 'react';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
        secondary:
          'bg-surface border border-border text-fg hover:bg-[var(--nx-hover)]',
        ghost: 'text-fg-muted hover:bg-[var(--nx-hover)] hover:text-fg',
        danger:
          'bg-danger-bg text-danger-fg border border-danger-border hover:opacity-90',
      },
      size: {
        sm: 'h-[var(--nx-control-sm)] px-2 text-xs rounded-md',
        md: 'h-[var(--nx-control-md)] px-3 text-sm rounded-md',
        lg: 'h-[var(--nx-control-lg)] px-4 text-sm rounded-md',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
