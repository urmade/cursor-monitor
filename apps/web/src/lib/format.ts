export function formatCost(cents: number | null): string {
  if (cents == null) return 'Pending';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents >= 100 ? 2 : 4,
    maximumFractionDigits: cents >= 100 ? 2 : 4,
  }).format(cents / 100);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : value;
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds == null) return 'Unknown';
  if (milliseconds < 1000) return `${milliseconds} ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}
