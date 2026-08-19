'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import Link from 'next/link';
import { useFormStatus } from 'react-dom';

type ValueTag = 'h1' | 'h2' | 'h3' | 'strong' | 'span';

type RenameControlProps = {
  action: (form: FormData) => Promise<void>;
  as?: ValueTag;
  canRename?: boolean;
  className?: string;
  href?: string;
  hiddenFields: Record<string, string>;
  placeholder: string;
  value: string;
};

function stop(event: { preventDefault(): void; stopPropagation(): void }) {
  event.preventDefault();
  event.stopPropagation();
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button className="button button-primary" disabled={pending} type="submit">
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

function DisplayValue({
  as: Tag = 'span',
  children,
  className,
  href,
}: {
  as?: ValueTag;
  children: ReactNode;
  className?: string;
  href?: string;
}) {
  const value = <Tag className={className}>{children}</Tag>;
  return href ? (
    <Link className="inline-rename-link" href={href}>
      {value}
    </Link>
  ) : (
    value
  );
}

export function RenameControl({
  action,
  as = 'span',
  canRename = true,
  className,
  href,
  hiddenFields,
  placeholder,
  value,
}: RenameControlProps) {
  const [editing, setEditing] = useState(false);

  if (!canRename) {
    return (
      <DisplayValue as={as} className={className} href={href}>
        {value}
      </DisplayValue>
    );
  }

  async function submit(formData: FormData) {
    await action(formData);
    setEditing(false);
  }

  if (editing) {
    return (
      <form
        action={submit}
        className="inline-rename-form"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            stop(event);
            setEditing(false);
          }
        }}
      >
        {Object.entries(hiddenFields).map(([name, fieldValue]) => (
          <input key={name} name={name} type="hidden" value={fieldValue} />
        ))}
        <input
          aria-label="Display name"
          autoFocus
          className={`inline-rename-input inline-rename-input-${as}${className ? ` ${className}` : ''}`}
          defaultValue={value}
          maxLength={120}
          name="displayName"
          placeholder={placeholder}
        />
        <SaveButton />
        <button
          className="button button-secondary"
          onClick={(event) => {
            stop(event);
            setEditing(false);
          }}
          type="button"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <span className="inline-rename">
      <DisplayValue as={as} className={className} href={href}>
        {value}
      </DisplayValue>
      <button
        className="button-link"
        onClick={(event) => {
          stop(event);
          setEditing(true);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        type="button"
      >
        Rename
      </button>
    </span>
  );
}
