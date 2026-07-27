'use client';

import { Button } from '@nexus/ui';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-fg">Something went wrong</p>
      <p className="max-w-md text-xs text-fg-muted">{error.message}</p>
      <Button type="button" variant="secondary" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
