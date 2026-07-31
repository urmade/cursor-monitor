import { PageHeader } from '@nexus/ui';
import { CursorOrganisationsSettings } from '../../../../src/components/CursorOrganisationsSettings';
import {
  formatApiKeyIdentity,
  resolveCursorAuth,
} from '../../../../src/server/cursor';
import { listCursorOrganisationViews } from '../../../../src/server/cursor-organisations';

export const dynamic = 'force-dynamic';

export default async function OrganisationsSettingsPage() {
  const [organisations, auth] = await Promise.all([
    listCursorOrganisationViews(),
    resolveCursorAuth(),
  ]);

  const envFallbackLabel =
    auth.source === 'env' && auth.me
      ? formatApiKeyIdentity(auth.me)
      : auth.source === 'env'
        ? 'env key'
        : null;

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <PageHeader
        title="Cursor organisations"
        subtitle="All configuration needed to connect Nexus to one or more Cursor organisations — API endpoint, API key, and organisation id."
        meta="Settings"
      />
      <CursorOrganisationsSettings
        organisations={organisations}
        envFallbackLabel={envFallbackLabel}
      />
    </div>
  );
}
