import { cn } from '../lib/cn';
import { Badge } from '../primitives/Badge';

export function LoopBadge({
  count,
  escalated,
  className,
}: {
  count: number;
  escalated?: boolean;
  className?: string;
}) {
  if (count <= 0 && !escalated) return null;
  return (
    <Badge
      tone={escalated ? 'danger' : 'warning'}
      className={cn(className)}
      title={escalated ? 'Loop escalated' : `${count} return${count === 1 ? '' : 's'}`}
    >
      {escalated ? '↻!' : `↻${count}`}
    </Badge>
  );
}
