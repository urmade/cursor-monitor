'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { AttentionKind, InFlightSummary } from '@nexus/contracts';
import { Badge, Button, Field, Input, Panel, PanelBody, PanelHeader, Textarea } from '@nexus/ui';
import { actionSnoozeAttention } from '../server/actions';

type InboxItem = {
  id: string;
  workItemKey?: string;
  projectId?: string;
  kind: AttentionKind;
  title: string;
  why: string;
  score: number;
  createdAt?: string;
  scoreExplain?: {
    ageBoost?: number;
    complexityBoost?: number;
    spendAtRiskBoost?: number;
  };
  meta?: { canAct?: boolean; scoreDescription?: string };
  actions?: Array<{ id: string; label: string; kind: string; requiresConfirm?: boolean }>;
};

type InboxGroup = { kind: AttentionKind; items: InboxItem[] };

const KIND_LABEL: Record<AttentionKind, string> = {
  blocking_question: 'Needs an answer',
  pending_approval: 'Approvals',
  budget_block: 'Budget',
  run_failed: 'Failed runs',
  run_completed_no_report: 'Missing reports',
  loop_escalation: 'Loop escalations',
  external_block: 'External blocks',
};

const ALL_KINDS = Object.keys(KIND_LABEL) as AttentionKind[];

function rowActions(item: InboxItem) {
  const optionActs = (item.actions ?? []).filter((a) => a.id.startsWith('opt_'));
  const otherActs = (item.actions ?? []).filter((a) => !a.id.startsWith('opt_'));
  return [...optionActs, ...otherActs];
}

type InboxAction = NonNullable<InboxItem['actions']>[number];

type PayloadDialog = {
  item: InboxItem;
  act: InboxAction;
};

function actionNeedsPayloadForm(act: InboxAction): boolean {
  return (
    act.kind === 'raise_project_cap' ||
    act.kind === 'raise_item_budget' ||
    act.kind === 'change_complexity' ||
    act.kind === 'reject' ||
    act.kind === 'loop_return'
  );
}

function usdToMicroUsd(usd: string): string {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return String(Math.round(n * 1_000_000));
}

function ageHours(createdAt: string | undefined, nowMs: number): string {
  if (!createdAt) return '—';
  const h = Math.max(0, (nowMs - new Date(createdAt).getTime()) / 3_600_000);
  if (h < 1) return '<1h open';
  return `${Math.round(h)}h open`;
}

function metaLine(item: InboxItem, nowMs: number): string {
  const ex = item.scoreExplain ?? {};
  const parts = [
    ageHours(item.createdAt, nowMs),
    ex.complexityBoost ? `complexity +${ex.complexityBoost}` : 'complexity —',
    ex.spendAtRiskBoost ? `spend +${ex.spendAtRiskBoost}` : 'spend —',
  ];
  return parts.join(' · ');
}

export function InboxClient({
  initialGroups,
  totalOpen,
  inFlight,
  projects,
}: {
  initialGroups: InboxGroup[];
  totalOpen: number;
  inFlight: InFlightSummary;
  projects: Array<{ id: string; key: string; name: string }>;
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [openCount, setOpenCount] = useState(totalOpen);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [payloadDialog, setPayloadDialog] = useState<PayloadDialog | null>(null);
  const [payloadUsd, setPayloadUsd] = useState('50');
  const [payloadReason, setPayloadReason] = useState('');
  const [payloadComment, setPayloadComment] = useState('');
  const [payloadComplexity, setPayloadComplexity] = useState<'low' | 'medium' | 'high'>('high');
  const [payloadNote, setPayloadNote] = useState('');
  const [answerDraft, setAnswerDraft] = useState<{ item: InboxItem; text: string } | null>(null);
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<AttentionKind | ''>('');
  const [minAgeHours, setMinAgeHours] = useState(0);
  const [selected, setSelected] = useState(0);
  const [pending, startTransition] = useTransition();
  const [updatedAt, setUpdatedAt] = useState(0);
  const [clock, setClock] = useState(0);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  useEffect(() => {
    const now = Date.now();
    // Client clock bootstrap after mount (SSR has no wall clock).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration
    setUpdatedAt(now);
    setClock(now);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.inboxClient = 'ready';
  }, []);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const projectKeyById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.key])),
    [projects],
  );

  const filteredFlat = useMemo(() => {
    return flat.filter((item) => {
      if (projectFilter && item.projectId !== projectFilter) return false;
      if (kindFilter && item.kind !== kindFilter) return false;
      if (minAgeHours > 0 && item.createdAt) {
        const h = (clock - new Date(item.createdAt).getTime()) / 3_600_000;
        if (h < minAgeHours) return false;
      }
      return true;
    });
  }, [flat, projectFilter, kindFilter, minAgeHours, clock]);

  const inboxUnfiltered =
    !projectFilter && !kindFilter && minAgeHours === 0;
  const needYouCount = inboxUnfiltered ? flat.length : openCount;

  const refresh = useCallback(async () => {
    const qs = new URLSearchParams();
    if (projectFilter) qs.append('projectId', projectFilter);
    if (kindFilter) qs.append('kind', kindFilter);
    const res = await fetch(`/api/inbox?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { groups: InboxGroup[]; totalOpen: number };
    setGroups(data.groups);
    setOpenCount(data.totalOpen);
    setUpdatedAt(Date.now());
  }, [projectFilter, kindFilter]);

  useEffect(() => {
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(id);
  }, [projectFilter, kindFilter, refresh]);

  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const runAction = useCallback(
    (
      item: InboxItem,
      action: string,
      payload?: Record<string, unknown>,
      options?: { optimistic?: boolean },
    ) => {
      const optimistic = options?.optimistic !== false;
      const prev = groups;
      const removedIdx = filteredFlat.findIndex((i) => i.id === item.id);
      if (optimistic) {
        startTransition(() => {
          setGroups((g) =>
            g
              .map((group) => ({
                ...group,
                items: group.items.filter((i) => i.id !== item.id),
              }))
              .filter((group) => group.items.length > 0),
          );
          setOpenCount((c) => Math.max(0, c - 1));
          setAnnouncement(`Resolved ${item.workItemKey ?? 'item'}: ${item.title}`);
        });
      }
      void (async () => {
        const res = await fetch('/api/inbox/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attentionItemId: item.id, action, payload }),
        });
        const result = (await res.json()) as {
          ok: boolean;
          error?: string;
          value?: { detail?: { navigate?: string | boolean } };
        };
        if (!res.ok || !result.ok) {
          if (optimistic) {
            setGroups(prev);
            setOpenCount(totalOpen);
          }
          setActionError(result.error ?? 'Action failed');
          return;
        }
        setActionError(null);
        const navigate = result.value?.detail?.navigate;
        if (typeof navigate === 'string') {
          window.open(navigate, '_blank', 'noopener,noreferrer');
          await refresh();
          return;
        }
        if (!optimistic) {
          await refresh();
          return;
        }
        const next = filteredFlat[removedIdx] ?? filteredFlat[removedIdx + 1];
        if (next) {
          requestAnimationFrame(() => rowRefs.current.get(next.id)?.focus());
        }
        await refresh();
      })();
    },
    [groups, refresh, totalOpen, filteredFlat],
  );

  const openPayloadDialog = useCallback((item: InboxItem, act: InboxAction) => {
    setPayloadReason('');
    setPayloadComment('');
    setPayloadNote('');
    setPayloadUsd(act.kind === 'raise_item_budget' ? '50' : '100');
    setPayloadComplexity('high');
    setPayloadDialog({ item, act });
  }, []);

  const submitPayloadDialog = useCallback(() => {
    if (!payloadDialog) return;
    const { item, act } = payloadDialog;
    if (act.kind === 'raise_project_cap') {
      if (!payloadReason.trim()) {
        setActionError('A reason is required to raise the project cap.');
        return;
      }
      runAction(item, act.kind, {
        microUsd: usdToMicroUsd(payloadUsd),
        reason: payloadReason.trim(),
      });
    } else if (act.kind === 'raise_item_budget') {
      if (!payloadReason.trim()) {
        setActionError('A reason is required to raise the item budget.');
        return;
      }
      runAction(item, act.kind, {
        microUsd: usdToMicroUsd(payloadUsd),
        reason: payloadReason.trim(),
      });
    } else if (act.kind === 'change_complexity') {
      runAction(item, act.kind, { complexity: payloadComplexity });
    } else if (act.kind === 'reject') {
      runAction(item, act.kind, { comment: payloadComment.trim() });
    } else if (act.kind === 'loop_return') {
      runAction(item, act.kind, {
        reasonCode: 'review_findings',
        note: payloadNote.trim() || 'Returned from inbox',
      });
    } else if (act.kind === 'accept_no_report') {
      runAction(item, act.kind);
    } else {
      runAction(item, act.kind);
    }
    setPayloadDialog(null);
  }, [
    payloadDialog,
    payloadUsd,
    payloadReason,
    payloadComment,
    payloadComplexity,
    payloadNote,
    runAction,
  ]);

  const fireAction = useCallback(
    (item: InboxItem, act: InboxAction) => {
      if (act.kind === 'open_ticket') {
        const key =
          projectKeyById.get(item.projectId ?? '') ?? projects.find((p) => p.key)?.key;
        if (key && item.workItemKey) {
          window.location.href = `/projects/${key}/items/${item.workItemKey}`;
        }
        return;
      }
      if (act.kind === 'answer') {
        if (act.id.startsWith('opt_')) {
          runAction(item, 'answer', { answer: act.label });
          return;
        }
        setAnswerDraft({ item, text: '' });
        return;
      }
      if (act.kind === 'open_cursor') {
        runAction(item, act.kind, undefined, { optimistic: false });
        return;
      }
      if (actionNeedsPayloadForm(act)) {
        openPayloadDialog(item, act);
        return;
      }
      if (act.requiresConfirm) {
        openPayloadDialog(item, act);
        return;
      }
      runAction(item, act.kind);
    },
    [projectKeyById, projects, runAction, openPayloadDialog],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'j') {
        setSelected((s) => Math.min(s + 1, Math.max(filteredFlat.length - 1, 0)));
      }
      if (e.key === 'k') {
        setSelected((s) => Math.max(s - 1, 0));
      }
      if (e.key === '?' && filteredFlat[selected]) {
        e.preventDefault();
        const item = filteredFlat[selected]!;
        setAnnouncement(item.meta?.scoreDescription ?? 'No score explanation');
      }
      if (e.key >= '1' && e.key <= '9' && filteredFlat[selected]) {
        const idx = Number(e.key) - 1;
        const acts = rowActions(filteredFlat[selected]!);
        const act = acts[idx];
        if (act) {
          e.preventDefault();
          fireAction(filteredFlat[selected]!, act);
        }
      }
      if (e.key === 's' && filteredFlat[selected]) {
        const row = filteredFlat[selected]!;
        if (row.meta?.canAct === false) return;
        void actionSnoozeAttention(
          row.id,
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        ).then(() => refresh());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filteredFlat, selected, fireAction, refresh]);

  const displayGroups = useMemo(() => {
    const byKind = new Map<AttentionKind, InboxItem[]>();
    for (const item of filteredFlat) {
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
    }
    return ALL_KINDS.filter((k) => byKind.has(k)).map((kind) => ({
      kind,
      items: byKind.get(kind)!,
    }));
  }, [filteredFlat]);

  if (inboxUnfiltered && flat.length === 0) {
    return (
      <Panel>
        <PanelHeader>
          <h2 className="text-sm font-medium text-fg">AI working — nothing needed from you</h2>
        </PanelHeader>
        <PanelBody>
          <p className="text-sm text-fg-muted">
            {inFlight.itemsInFlight} items in flight
            {inFlight.oldestRunMinutes != null
              ? ` · oldest run ${inFlight.oldestRunMinutes}m`
              : ''}
            {inFlight.activeRunCount > 0 ? ` · ${inFlight.activeRunCount} active runs` : ''}
          </p>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {announcement}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-medium text-fg">Inbox · {needYouCount} need you</h1>
        <span className="text-xs text-fg-muted">
          Updated {updatedAt ? Math.round((clock - updatedAt) / 1000) : 0}s ago
          {pending ? ' · saving…' : ''}
        </span>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          Project
          <select
            className="rounded-md border border-border bg-canvas px-2 py-1"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Kind
          <select
            className="rounded-md border border-border bg-canvas px-2 py-1"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as AttentionKind | '')}
          >
            <option value="">All</option>
            {ALL_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Min age (h)
          <input
            type="number"
            min={0}
            className="w-16 rounded-md border border-border bg-canvas px-2 py-1"
            value={minAgeHours}
            onChange={(e) => setMinAgeHours(Number(e.target.value) || 0)}
          />
        </label>
      </div>

      {actionError ? (
        <p
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      <p className="text-xs text-fg-muted">
        Shortcuts: <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd>{' '}
        move, <kbd className="font-mono">1</kbd>–<kbd className="font-mono">9</kbd> act,{' '}
        <kbd className="font-mono">s</kbd> snooze, <kbd className="font-mono">?</kbd> score
      </p>

      {payloadDialog ? (
        <Panel>
          <PanelHeader>
            <span className="text-sm font-medium">Confirm: {payloadDialog.act.label}</span>
          </PanelHeader>
          <PanelBody className="grid gap-3">
            {payloadDialog.act.kind === 'raise_project_cap' ||
            payloadDialog.act.kind === 'raise_item_budget' ? (
              <>
                <Field label="Amount (USD)">
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={payloadUsd}
                    onChange={(e) => setPayloadUsd(e.target.value)}
                  />
                </Field>
                <Field label="Reason">
                  <Textarea
                    rows={2}
                    value={payloadReason}
                    onChange={(e) => setPayloadReason(e.target.value)}
                    required
                  />
                </Field>
              </>
            ) : null}
            {payloadDialog.act.kind === 'change_complexity' ? (
              <Field label="New complexity">
                <select
                  className="h-9 rounded border border-border bg-surface px-2 text-sm"
                  value={payloadComplexity}
                  onChange={(e) =>
                    setPayloadComplexity(e.target.value as 'low' | 'medium' | 'high')
                  }
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
            ) : null}
            {payloadDialog.act.kind === 'reject' ? (
              <Field label="Comment (optional)">
                <Textarea
                  rows={2}
                  value={payloadComment}
                  onChange={(e) => setPayloadComment(e.target.value)}
                />
              </Field>
            ) : null}
            {payloadDialog.act.kind === 'loop_return' ? (
              <Field label="Note (optional)">
                <Textarea
                  rows={2}
                  value={payloadNote}
                  onChange={(e) => setPayloadNote(e.target.value)}
                />
              </Field>
            ) : null}
            {payloadDialog.act.kind === 'accept_no_report' ? (
              <p className="text-sm text-fg-muted">
                Accept this run without a stage report? The attention item will be cleared.
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={submitPayloadDialog}>
                Confirm
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPayloadDialog(null)}>
                Cancel
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      {answerDraft ? (
        <Panel>
          <PanelHeader>
            <span className="text-sm font-medium">Your answer</span>
          </PanelHeader>
          <PanelBody className="space-y-2">
            <textarea
              className="w-full rounded-md border border-border bg-canvas p-2 text-sm"
              value={answerDraft.text}
              onChange={(e) => setAnswerDraft({ ...answerDraft, text: e.target.value })}
              rows={3}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  if (answerDraft.text.trim()) {
                    runAction(answerDraft.item, 'answer', { answer: answerDraft.text.trim() });
                    setAnswerDraft(null);
                  }
                }}
              >
                Submit answer
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAnswerDraft(null)}>
                Cancel
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      {displayGroups.map((group) => (
        <section key={group.kind} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {KIND_LABEL[group.kind]} ({group.items.length})
          </h2>
          <ul className="space-y-2">
            {group.items.map((item) => {
              const globalIdx = filteredFlat.indexOf(item);
              const isSel = globalIdx === selected;
              const canAct = item.meta?.canAct !== false;
              const acts = rowActions(item);
              const otherActs = acts.filter((a) => !a.id.startsWith('opt_'));
              return (
                <li
                  key={item.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(item.id, el);
                  }}
                  tabIndex={-1}
                  data-testid={`inbox-row-${item.id}`}
                  className={`rounded-lg border border-border bg-surface p-4 outline-none ${isSel ? 'ring-2 ring-accent' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        {item.workItemKey && item.projectId && projectKeyById.get(item.projectId) ? (
                          <Link
                            href={`/projects/${projectKeyById.get(item.projectId)}/items/${item.workItemKey}`}
                            className="inline-flex"
                          >
                            <Badge tone="warning">{item.workItemKey}</Badge>
                          </Link>
                        ) : (
                          <Badge tone="warning">{item.workItemKey}</Badge>
                        )}
                        <span className="text-sm font-medium text-fg">{item.title}</span>
                      </div>
                      <p className="mt-1 text-sm text-fg-muted">{item.why}</p>
                      <p className="mt-1 text-xs text-fg-muted">{metaLine(item, clock)}</p>
                      {item.meta?.scoreDescription ? (
                        <p className="mt-2 text-xs text-fg-muted">{item.meta.scoreDescription}</p>
                      ) : null}
                    </div>
                    <span className="text-xs text-fg-muted">score {item.score}</span>
                  </div>
                  {!canAct ? (
                    <p className="mt-2 text-xs text-fg-muted">
                      View only — you need maintainer or owner rights to act on this row.
                    </p>
                  ) : null}
                  {acts.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {acts.map((act, i) => {
                        const isOption = act.id.startsWith('opt_');
                        const otherIdx = isOption ? -1 : otherActs.indexOf(act);
                        return (
                          <Button
                            key={act.id}
                            size="sm"
                            variant={
                              isOption ? 'secondary' : otherIdx === 0 ? 'primary' : 'secondary'
                            }
                            disabled={!canAct && act.kind !== 'open_ticket'}
                            data-testid={`inbox-option-${i + 1}`}
                            onClick={() => fireAction(item, act)}
                          >
                            {act.label}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
