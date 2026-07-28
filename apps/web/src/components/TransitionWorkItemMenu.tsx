'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@nexus/ui';

type Stage = { id: string; name: string; position: number };
type ReasonCode = {
  code: string;
  label: string;
  requiresNote: boolean;
};

export function TransitionWorkItemMenu({
  workItemId,
  expectedVersion,
  projectKey,
  itemKey,
  currentStageId,
  currentStagePosition,
  stages,
  reasonCodes,
  action,
}: {
  workItemId: string;
  expectedVersion: number;
  projectKey: string;
  itemKey: string;
  currentStageId: string;
  currentStagePosition: number;
  stages: Stage[];
  reasonCodes: ReasonCode[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const targets = stages.filter((s) => s.id !== currentStageId);
  const [pending, setPending] = useState<Stage | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');

  const isReturn = useMemo(() => {
    if (!pending) return false;
    return pending.position < currentStagePosition;
  }, [pending, currentStagePosition]);

  const selectedReason = reasonCodes.find((r) => r.code === reasonCode);
  const noteRequired = Boolean(selectedReason?.requiresNote);

  if (targets.length === 0) return null;

  function openTarget(stage: Stage) {
    if (stage.position < currentStagePosition) {
      setPending(stage);
      setReasonCode('');
      setNote('');
      return;
    }
    // Forward/lateral — submit immediately via a synthetic form post.
    const fd = new FormData();
    fd.set('workItemId', workItemId);
    fd.set('expectedVersion', String(expectedVersion));
    fd.set('projectKey', projectKey);
    fd.set('itemKey', itemKey);
    fd.set('toStageId', stage.id);
    fd.set('kind', 'advance');
    void action(fd);
  }

  function submitReturn() {
    if (!pending || !reasonCode) return;
    if (noteRequired && !note.trim()) return;
    const fd = new FormData();
    fd.set('workItemId', workItemId);
    fd.set('expectedVersion', String(expectedVersion));
    fd.set('projectKey', projectKey);
    fd.set('itemKey', itemKey);
    fd.set('toStageId', pending.id);
    fd.set('kind', 'return');
    fd.set('reasonCode', reasonCode);
    if (note.trim()) fd.set('note', note.trim());
    setPending(null);
    void action(fd);
  }

  return (
    <div className="mt-2 grid gap-2">
      <div className="flex flex-wrap gap-1">
        {targets.map((s) => (
          <Button
            key={s.id}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => openTarget(s)}
          >
            {s.position < currentStagePosition ? `↩ ${s.name}` : s.name}
          </Button>
        ))}
      </div>

      <Dialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return to {pending?.name}</DialogTitle>
            <DialogDescription>
              Every return needs a reason. This becomes part of the ticket&apos;s
              loop history.
            </DialogDescription>
          </DialogHeader>
          {isReturn ? (
            <div className="grid gap-3">
              <Field label="Reason">
                <Select value={reasonCode} onValueChange={setReasonCode}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {reasonCodes.map((r) => (
                      <SelectItem key={r.code} value={r.code}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={noteRequired ? 'Note (required)' : 'Note (optional)'}>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  required={noteRequired}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPending(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!reasonCode || (noteRequired && !note.trim())}
                  onClick={submitReturn}
                >
                  Confirm return
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
