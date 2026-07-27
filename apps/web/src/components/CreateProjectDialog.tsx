'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Textarea,
} from '@nexus/ui';
import { actionCreateProject } from '../server/actions';

export function CreateProjectDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm">New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Each project owns its pipeline and label taxonomy.
          </DialogDescription>
        </DialogHeader>
        <form action={actionCreateProject} className="mt-4 grid gap-3">
          <Field label="Key">
            <Input
              name="key"
              required
              placeholder="ACME"
              className="font-mono uppercase"
            />
          </Field>
          <Field label="Name">
            <Input name="name" required placeholder="Acme Platform" />
          </Field>
          <Field label="Description">
            <Textarea name="description" rows={2} />
          </Field>
          <Field label="Template">
            <select
              name="template"
              defaultValue="default"
              className="flex h-[var(--nx-control-md)] w-full rounded-md border border-border bg-surface px-2.5 text-sm text-fg"
            >
              <option value="default">Default (6 stages)</option>
              <option value="minimal">Minimal (3 stages)</option>
              <option value="empty">Empty</option>
            </select>
          </Field>
          <Button type="submit" className="mt-2 w-fit">Create</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
