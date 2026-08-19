'use client';

import { useRef } from 'react';
import { useFormStatus } from 'react-dom';

type RenameControlProps = {
  action: (form: FormData) => Promise<void>;
  ariaLabel: string;
  eyebrow: string;
  title: string;
  lede: string;
  stableLabel: string;
  stableValue: string;
  currentName: string;
  placeholder: string;
  hiddenFields: Record<string, string>;
};

function SaveNameButton() {
  const { pending } = useFormStatus();
  return (
    <button className="button button-primary" disabled={pending} type="submit">
      {pending ? 'Saving…' : 'Save name'}
    </button>
  );
}

export function RenameControl({
  action,
  ariaLabel,
  eyebrow,
  title,
  lede,
  stableLabel,
  stableValue,
  currentName,
  placeholder,
  hiddenFields,
}: RenameControlProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  function open() {
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function submit(formData: FormData) {
    await action(formData);
    close();
  }

  return (
    <>
      <button
        aria-label={ariaLabel}
        className="button button-secondary"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          open();
        }}
        type="button"
      >
        Rename
      </button>
      <dialog
        aria-label={title}
        className="rename-dialog"
        ref={dialogRef}
      >
        <div className="rename-dialog-body">
          <header className="page-heading">
            <div>
              <p className="eyebrow">{eyebrow}</p>
              <h1>{title}</h1>
              <p className="lede">{lede}</p>
            </div>
          </header>
          <section className="panel rename-panel">
            <form action={submit} className="rename-form">
              {Object.entries(hiddenFields).map(([name, value]) => (
                <input key={name} name={name} type="hidden" value={value} />
              ))}
              <div className="rename-identity">
                <span className="small subtle">{stableLabel}</span>
                <strong className="mono">{stableValue}</strong>
              </div>
              <label className="field">
                <span>Display name</span>
                <input
                  autoFocus
                  defaultValue={currentName}
                  key={currentName}
                  maxLength={120}
                  name="displayName"
                  placeholder={placeholder}
                />
              </label>
              <p className="small muted">
                Leave blank to restore the default name. The stable{' '}
                {stableLabel.toLowerCase()} never changes.
              </p>
              <div className="rename-actions">
                <SaveNameButton />
                <button
                  className="button button-secondary"
                  onClick={close}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        </div>
      </dialog>
    </>
  );
}
