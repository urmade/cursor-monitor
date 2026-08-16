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
        subtitle="Connect Cursor organisations. Team API keys are tested against the Team usage API and power Monitoring cost."
        meta="Settings"
      />
      <CursorOrganisationsSettings
        organisations={organisations}
        envFallbackLabel={envFallbackLabel}
      />
    </div>
  );
}
