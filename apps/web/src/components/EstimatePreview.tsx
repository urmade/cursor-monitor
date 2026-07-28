'use client';

import { useEffect, useState } from 'react';
import { EstimateDisplay, Skeleton, type CostEstimateView } from '@nexus/ui';

/**
 * Fetches a live estimate while the create form's complexity/labels change.
 * Labels the result as an estimate (or cold start) — never a bare number.
 */
export function EstimatePreview({
  projectKey,
  complexity,
  labelKeys,
}: {
  projectKey: string;
  complexity: string;
  labelKeys: string[];
}) {
  const [estimate, setEstimate] = useState<CostEstimateView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelsKey = labelKeys.join(',');

  useEffect(() => {
    if (!complexity) return;
    const params = new URLSearchParams({
      complexity,
      labels: labelsKey,
    });
    let cancelled = false;
    setLoading(true);
    fetch(`/api/internal/estimate?projectKey=${encodeURIComponent(projectKey)}&${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((body) => {
        if (!cancelled) {
          setEstimate(body.estimate as CostEstimateView);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'estimate failed');
          setEstimate(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, complexity, labelsKey]);

  if (!complexity) return null;
  if (loading && !estimate) {
    return <Skeleton className="h-10 w-full max-w-md" data-testid="estimate-preview-loading" />;
  }
  if (error) {
    return <p className="text-xs text-fg-muted">Estimate unavailable.</p>;
  }
  return <EstimateDisplay estimate={estimate} />;
}
