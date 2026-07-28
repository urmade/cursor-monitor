import { describe, expect, it } from 'vitest';
import { PUBLIC_EVENTS, PUBLIC_EVENT_TYPES } from './catalog';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodSchemaFingerprint } from './schema-fingerprint';

const repoDocs = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/events.md');

describe('public event catalogue freeze', () => {
  it('has a stable hash per public event schema version', () => {
    const snapshot: Record<string, string> = {};
    for (const type of PUBLIC_EVENT_TYPES) {
      const entry = PUBLIC_EVENTS[type];
      const schemaJson = zodSchemaFingerprint(entry.schema);
      snapshot[type] = createHash('sha256')
        .update(`${entry.version}:${schemaJson}`)
        .digest('hex');
    }
    expect(snapshot).toMatchSnapshot();
  });

  it('documents every public type', () => {
    const doc = readFileSync(repoDocs, 'utf8');
    for (const type of PUBLIC_EVENT_TYPES) {
      expect(doc).toContain(type);
    }
  });
});
