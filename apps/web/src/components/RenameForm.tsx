import type { ReactNode } from 'react';
import Link from 'next/link';

type RenameFormProps = {
  action: (form: FormData) => Promise<void>;
  breadcrumbs: ReactNode;
  eyebrow: string;
  title: string;
  lede: string;
  stableLabel: string;
  stableValue: string;
  currentName: string;
  placeholder: string;
  hiddenFields: Record<string, string>;
  cancelHref: string;
};

export function RenameForm({
  action,
  breadcrumbs,
  eyebrow,
  title,
  lede,
  stableLabel,
  stableValue,
  currentName,
  placeholder,
  hiddenFields,
  cancelHref,
}: RenameFormProps) {
  return (
    <div className="stack rename-page">
      {breadcrumbs}
      <header className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="lede">{lede}</p>
        </div>
      </header>

      <section className="panel rename-panel">
        <form action={action} className="rename-form">
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
              maxLength={120}
              name="displayName"
              placeholder={placeholder}
            />
          </label>
          <p className="small muted">
            Leave blank to restore the default name. The stable {stableLabel.toLowerCase()}{' '}
            never changes.
          </p>
          <div className="rename-actions">
            <button className="button button-primary" type="submit">
              Save name
            </button>
            <Link className="button button-secondary" href={cancelHref}>
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
