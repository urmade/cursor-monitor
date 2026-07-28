'use client';

import { useFormStatus } from 'react-dom';
import { Button } from '@nexus/ui';

export function RunBacktestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Running backtest…' : 'Run backtest now'}
    </Button>
  );
}
