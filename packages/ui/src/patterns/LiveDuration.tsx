'use client';

import { useEffect, useState } from 'react';

export type LiveDurationProps = {
  since: Date | string;
  until?: Date | string | null;
  className?: string;
  liveSuffix?: string;
};

function toEpochMs(value: Date | string): number {
  return typeof value === 'string' ? new Date(value).getTime() : value.getTime();
}

function formatElapsedSeconds(sinceMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - sinceMs) / 1000));
}

export function LiveDuration({
  since,
  until,
  className,
  liveSuffix = '',
}: LiveDurationProps) {
  const sinceMs = toEpochMs(since);
  const untilMs = until != null ? toEpochMs(until) : null;
  const isLive = untilMs == null;

  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!isLive) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isLive, sinceMs]);

  if (!isLive) {
    const seconds = formatElapsedSeconds(sinceMs, untilMs);
    return (
      <span className={className}>
        {seconds}s
      </span>
    );
  }

  if (nowMs == null) {
    return <span className={className}>…{liveSuffix}</span>;
  }

  const seconds = formatElapsedSeconds(sinceMs, nowMs);
  return (
    <span className={className}>
      {seconds}s{liveSuffix}
    </span>
  );
}
