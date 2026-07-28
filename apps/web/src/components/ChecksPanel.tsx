'use client';

import { Badge, Button, Panel, PanelBody, PanelHeader } from '@nexus/ui';
import { useState, useTransition } from 'react';

type GateCheck = {
  gateId: string;
  gateName: string;
  outcome: string;
  reason: string;
  evidence?: Record<string, unknown>;
  gateVersion?: number;
};

type WarningRow = {
  id: string;
  code: string;
  message: string;
  status: string;
};

type ApprovalRow = {
  id: string;
  gateId: string;
  gateName?: string;
  status: string;
  instructions?: string;
};

function outcomeTone(
  outcome: string,
): 'success' | 'warning' | 'danger' | 'neutral' | 'active' {
  switch (outcome) {
    case 'pass':
      return 'success';
    case 'warn':
      return 'warning';
    case 'block':
    case 'error':
      return 'danger';
    case 'skipped':
      return 'neutral';
    default:
      return 'active';
  }
}

export function ChecksPanel({
  checks,
  warnings,
  approvals,
  canDecide,
  canDismiss,
  dismissAction,
  decideAction,
  projectKey,
  itemKey,
}: {
  checks: GateCheck[];
  warnings: WarningRow[];
  approvals: ApprovalRow[];
  canDecide: boolean;
  canDismiss: boolean;
  dismissAction: (formData: FormData) => void | Promise<void>;
  decideAction: (formData: FormData) => void | Promise<void>;
  projectKey: string;
  itemKey: string;
}) {
  return (
    <Panel>
      <PanelHeader>
        <span className="text-sm font-medium text-fg">Checks</span>
      </PanelHeader>
      <PanelBody className="space-y-4">
        {checks.length === 0 && warnings.length === 0 && approvals.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No gate results yet. When a transition or event fires a gate, Pass /
            Warn / Block outcomes appear here with evidence so anyone can see why
            work is stopped and what would unblock it.
          </p>
        ) : null}

        {approvals.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">
              Pending approvals
            </div>
            {approvals.map((a) => (
              <div
                key={a.id}
                className="rounded-md border border-border bg-surface-muted/40 p-3"
              >
                <div className="flex items-center gap-2">
                  <Badge tone="warning">needs approval</Badge>
                  <span className="text-sm text-fg">{a.gateName ?? a.gateId}</span>
                </div>
                {a.instructions ? (
                  <p className="mt-1 text-xs text-fg-muted">{a.instructions}</p>
                ) : null}
                {canDecide ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <form action={decideAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="approvalId" value={a.id} />
                      <input type="hidden" name="decision" value="approved" />
                      <input type="hidden" name="projectKey" value={projectKey} />
                      <input type="hidden" name="itemKey" value={itemKey} />
                      <input
                        name="comment"
                        placeholder="Comment (optional)"
                        className="h-8 rounded border border-border bg-surface px-2 text-xs"
                      />
                      <Button type="submit" size="sm">
                        Approve
                      </Button>
                    </form>
                    <form action={decideAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="approvalId" value={a.id} />
                      <input type="hidden" name="decision" value="rejected" />
                      <input type="hidden" name="projectKey" value={projectKey} />
                      <input type="hidden" name="itemKey" value={itemKey} />
                      <input
                        name="comment"
                        placeholder="Rejection reason"
                        required
                        className="h-8 rounded border border-border bg-surface px-2 text-xs"
                      />
                      <Button type="submit" size="sm" variant="secondary">
                        Reject
                      </Button>
                    </form>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">
              Open warnings
            </div>
            {warnings.map((w) => (
              <div
                key={w.id}
                className="flex items-start justify-between gap-2 rounded-md border border-warning-border/60 bg-warning-bg/20 p-3"
              >
                <div>
                  <Badge tone="warning">{w.code}</Badge>
                  <p className="mt-1 text-sm text-fg">{w.message}</p>
                </div>
                {canDismiss ? (
                  <form action={dismissAction} className="shrink-0">
                    <input type="hidden" name="warningId" value={w.id} />
                    <input type="hidden" name="projectKey" value={projectKey} />
                    <input type="hidden" name="itemKey" value={itemKey} />
                    <input
                      type="text"
                      name="reason"
                      required
                      placeholder="Why dismiss?"
                      className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-xs"
                    />
                    <Button type="submit" size="sm" variant="ghost">
                      Dismiss
                    </Button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {checks.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">
              Latest gate results
            </div>
            {checks.map((c) => (
              <div
                key={`${c.gateId}-${c.outcome}-${c.reason}`}
                className="rounded-md border border-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={outcomeTone(c.outcome)}>{c.outcome}</Badge>
                  <span className="text-sm font-medium text-fg">{c.gateName}</span>
                  {c.gateVersion != null ? (
                    <span className="font-mono text-[10px] text-fg-muted">
                      v{c.gateVersion}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-fg-muted">{c.reason}</p>
              </div>
            ))}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

export function WhyCantMove({
  stages,
  currentStageId,
  dryRunAction,
  workItemId,
  projectKey,
  itemKey,
  expectedVersion,
  canOverride,
  transitionAction,
}: {
  stages: Array<{ id: string; name: string }>;
  currentStageId: string;
  dryRunAction: (formData: FormData) => Promise<{
    ok: boolean;
    outcome?: string;
    blockedBy?: Array<{ gateName: string; reason: string; outcome: string }>;
    error?: string;
  }>;
  workItemId: string;
  projectKey: string;
  itemKey: string;
  expectedVersion: number;
  canOverride: boolean;
  transitionAction: (formData: FormData) => void | Promise<void>;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{
    outcome?: string;
    blockedBy?: Array<{ gateName: string; reason: string; outcome: string }>;
    error?: string;
  } | null>(null);
  const [toStageId, setToStageId] = useState(
    stages.find((s) => s.id !== currentStageId)?.id ?? '',
  );

  return (
    <Panel>
      <PanelHeader>
        <span className="text-sm font-medium text-fg">Why can&apos;t I move this?</span>
      </PanelHeader>
      <PanelBody className="space-y-3">
        <p className="text-xs text-fg-muted">
          Dry-run every applicable gate for a target stage without changing the
          ticket. All failing checks are listed at once.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-fg-muted">
            Target stage
            <select
              className="mt-1 block h-8 rounded border border-border bg-surface px-2 text-sm"
              value={toStageId}
              onChange={(e) => setToStageId(e.target.value)}
            >
              {stages
                .filter((s) => s.id !== currentStageId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending || !toStageId}
            onClick={() => {
              start(async () => {
                const fd = new FormData();
                fd.set('workItemId', workItemId);
                fd.set('toStageId', toStageId);
                fd.set('projectKey', projectKey);
                const r = await dryRunAction(fd);
                setResult(r);
              });
            }}
          >
            {pending ? 'Checking…' : 'Dry-run gates'}
          </Button>
        </div>
        {result ? (
          <div className="space-y-2">
            <Badge
              tone={
                result.outcome === 'block'
                  ? 'danger'
                  : result.outcome === 'warn'
                    ? 'warning'
                    : 'success'
              }
            >
              {result.outcome ?? result.error ?? 'done'}
            </Badge>
            {(result.blockedBy ?? []).map((b, i) => (
              <div key={i} className="text-sm text-fg">
                <span className="font-medium">{b.gateName}</span>
                <span className="text-fg-muted"> — {b.reason}</span>
              </div>
            ))}
            {result.outcome === 'block' && canOverride ? (
              <form action={transitionAction} className="mt-2 grid gap-2">
                <input type="hidden" name="workItemId" value={workItemId} />
                <input type="hidden" name="toStageId" value={toStageId} />
                <input type="hidden" name="expectedVersion" value={expectedVersion} />
                <input type="hidden" name="projectKey" value={projectKey} />
                <input type="hidden" name="itemKey" value={itemKey} />
                <input
                  name="overrideReason"
                  required
                  placeholder="Override reason (required)"
                  className="h-8 rounded border border-border bg-surface px-2 text-xs"
                />
                <Button type="submit" size="sm" variant="secondary">
                  Override and move
                </Button>
              </form>
            ) : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
