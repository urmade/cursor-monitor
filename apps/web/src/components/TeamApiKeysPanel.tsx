'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
} from '@nexus/ui';
import {
  actionAddCursorOrganisationApiKey,
  actionRemoveCursorOrganisationApiKey,
  actionUpsertCursorOrganisation,
  actionValidateUserTeamApiKey,
} from '../server/cursor-organisations';
import {
  actionBackfillStopHookCosts,
  type BackfillHookCostsResult,
} from '../server/hook-cost-backfill';
import type { CursorOrganisationView } from '../server/cursor-org-store';

function formatBackfillSummary(
  summary: Extract<BackfillHookCostsResult, { ok: true }>['summary'],
): string {
  if (summary.skippedNoHooks) return 'No stop hooks recorded yet.';
  const from = summary.fromReceivedAt
    ? new Date(summary.fromReceivedAt).toISOString().slice(0, 10)
    : 'the first hook';
  const parts = [
    `Matched ${summary.upgraded} of ${summary.pending} pending turn${summary.pending === 1 ? '' : 's'}`,
    `from ${summary.usageEvents} usage event${summary.usageEvents === 1 ? '' : 's'} (since ${from}).`,
  ];
  if (summary.unmatched > 0) {
    parts.push(
      `${summary.unmatched} still unmatched.`,
    );
  }
  if (summary.usageTruncated) {
    parts.push('Usage list was truncated; run again after matching.');
  }
  if (summary.pendingTruncated) {
    parts.push('Pending list was truncated; run again to continue.');
  }
  return parts.join(' ');
}

type KeyCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; note: string }
  | { status: 'error'; note: string };

function KeyCheckFeedback({ state }: { state: KeyCheckState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'checking') {
    return <p className="text-xs text-fg-muted">Checking Team API key with Cursor…</p>;
  }
  if (state.status === 'ok') {
    return (
      <p className="text-xs text-success-fg" role="status">
        {state.note}
      </p>
    );
  }
  return (
    <p className="text-xs text-danger-fg" role="alert">
      {state.note}
    </p>
  );
}

type TeamKeyRow = {
  id: string;
  label: string;
  hint: string;
  identityLabel: string | null;
  organisationId: string;
  organisationLabel: string;
  canRemove: boolean;
};

function collectTeamKeys(organisations: CursorOrganisationView[]): TeamKeyRow[] {
  return organisations.flatMap((org) =>
    org.keys
      .filter((key) => key.keyKind === 'service_account')
      .map((key) => ({
        id: key.id,
        label: key.label,
        hint: key.hint,
        identityLabel: key.identityLabel,
        organisationId: org.id,
        organisationLabel: org.label,
        canRemove: key.canRemove,
      })),
  );
}

export function TeamApiKeysPanel({
  organisations,
}: {
  organisations: CursorOrganisationView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [organisationId, setOrganisationId] = useState(
    organisations.find((org) => org.source === 'db')?.id ?? 'new',
  );
  const [newOrgLabel, setNewOrgLabel] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyCheck, setKeyCheck] = useState<KeyCheckState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [backfilling, startBackfill] = useTransition();

  const teamKeys = collectTeamKeys(organisations);
  const dbOrgs = organisations.filter((org) => org.source === 'db');
  const selectedOrg =
    organisationId === 'new'
      ? null
      : dbOrgs.find((org) => org.id === organisationId) ?? dbOrgs[0] ?? null;
  const baseUrl = selectedOrg?.baseUrl ?? 'https://api.cursor.com';

  function checkKey(value = apiKey) {
    if (value.trim().length < 20) return;
    const fd = new FormData();
    fd.set('apiKey', value);
    fd.set('baseUrl', baseUrl);
    fd.set('keyKind', 'service_account');
    setKeyCheck({ status: 'checking' });
    startTransition(async () => {
      const result = await actionValidateUserTeamApiKey(fd);
      setKeyCheck(
        result.ok
          ? { status: 'ok', note: result.note }
          : { status: 'error', note: result.error },
      );
    });
  }

  function resetDialog() {
    setOpen(false);
    setLabel('');
    setApiKey('');
    setNewOrgLabel('');
    setKeyCheck({ status: 'idle' });
    setOrganisationId(dbOrgs[0]?.id ?? 'new');
  }

  return (
    <Panel id="team-api-keys">
      <PanelHeader>
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">Team API keys</div>
          <p className="text-xs text-fg-muted">
            Monitoring prices local requests from the Cursor Team usage API.
            Keys are tested against POST /teams/filtered-usage-events before
            they are saved. Cost is filled in about five minutes after each
            stop hook. Match historical cost pages every usage event from the
            first recorded hook through now and joins on conversation id
            (summing every matching usage event, including rows that were
            previously priced by time/model guess).
          </p>
        </div>
      </PanelHeader>
      <PanelBody className="space-y-3">
        {teamKeys.length === 0 ? (
          <p className="text-sm text-warning-fg">
            No Team API key yet — charged cost stays pending until you add one
            from Cursor Dashboard → Settings → API Keys (team).
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {teamKeys.map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-fg">{key.label}</p>
                  <p className="text-xs text-fg-muted">
                    {key.organisationLabel}
                    {key.identityLabel ? ` · ${key.identityLabel}` : ''} ·{' '}
                    <span className="font-mono">{key.hint}</span>
                  </p>
                </div>
                {key.canRemove ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setError(null);
                      setMessage(null);
                      startTransition(async () => {
                        const result =
                          await actionRemoveCursorOrganisationApiKey(key.id);
                        if (!result.ok) {
                          setError(result.error);
                          return;
                        }
                        setMessage(`Removed “${key.label}”.`);
                        router.refresh();
                      });
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => setOpen(true)}>
            Add Team API key
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || backfilling}
            onClick={() => {
              setBackfillError(null);
              setBackfillNote(null);
              startBackfill(async () => {
                const result = await actionBackfillStopHookCosts();
                if (!result.ok) {
                  setBackfillError(result.error);
                  return;
                }
                setBackfillNote(formatBackfillSummary(result.summary));
                router.refresh();
              });
            }}
          >
            {backfilling ? 'Matching historical cost…' : 'Match historical cost'}
          </Button>
          {message ? (
            <p className="text-xs text-success-fg">{message}</p>
          ) : null}
          {error ? (
            <p className="text-xs text-danger-fg" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {backfillNote ? (
          <p className="text-xs text-success-fg" role="status">
            {backfillNote}
          </p>
        ) : null}
        {backfillError ? (
          <p className="text-xs text-danger-fg" role="alert">
            {backfillError}
          </p>
        ) : null}
      </PanelBody>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) resetDialog();
          else setOpen(true);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Team API key</DialogTitle>
            <DialogDescription>
              Paste a Team API key (not a personal User key). We call the Team
              usage API to confirm it before saving.
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              setMessage(null);
              startTransition(async () => {
                const creatingOrg = organisationId === 'new' || !selectedOrg;
                if (creatingOrg) {
                  const fd = new FormData();
                  fd.set(
                    'label',
                    newOrgLabel.trim() || 'Monitoring',
                  );
                  fd.set('baseUrl', 'https://api.cursor.com');
                  fd.set('apiKey', apiKey);
                  fd.set('keyKind', 'service_account');
                  fd.set('keyLabel', label.trim() || 'Team API key');
                  const result = await actionUpsertCursorOrganisation(fd);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setMessage(
                    `Saved Team API key${result.identity ? ` · ${result.identity}` : ''}`,
                  );
                } else {
                  const fd = new FormData();
                  fd.set('organisationId', selectedOrg.id);
                  fd.set('apiKey', apiKey);
                  fd.set('keyKind', 'service_account');
                  fd.set('label', label.trim() || 'Team API key');
                  const result = await actionAddCursorOrganisationApiKey(fd);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setMessage(
                    `Attached Team API key${result.identity ? ` · ${result.identity}` : ''}`,
                  );
                }
                resetDialog();
                router.refresh();
              });
            }}
          >
            <Field label="Organisation">
              <select
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
                value={organisationId}
                disabled={pending}
                onChange={(e) => setOrganisationId(e.target.value)}
              >
                {dbOrgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.label}
                  </option>
                ))}
                <option value="new">New organisation…</option>
              </select>
            </Field>
            {organisationId === 'new' || dbOrgs.length === 0 ? (
              <Field label="New organisation name">
                <Input
                  value={newOrgLabel}
                  onChange={(e) => setNewOrgLabel(e.target.value)}
                  placeholder="Monitoring"
                  disabled={pending}
                />
              </Field>
            ) : null}
            <Field label="Key name">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Team usage key"
                disabled={pending}
              />
            </Field>
            <Field label="Team API key">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyCheck({ status: 'idle' });
                }}
                onBlur={(e) => checkKey(e.target.value)}
                placeholder="Team API key from Cursor Dashboard"
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending || apiKey.trim().length < 20}
                onClick={() => checkKey()}
              >
                Check key
              </Button>
              <KeyCheckFeedback state={keyCheck} />
            </div>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={resetDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending || keyCheck.status === 'error'}
              >
                {pending ? 'Saving…' : 'Save Team API key'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
