import Link from 'next/link';
import { Badge, Button, Panel, PanelBody } from '@nexus/ui';
import {
  comingSoonCopy,
  type ComingSoonFeature,
} from '../lib/coming-soon';

export function ComingSoonSplash({ feature }: { feature: ComingSoonFeature }) {
  const copy = comingSoonCopy(feature);

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center p-4">
      <Panel className="w-full max-w-md" data-testid="coming-soon-splash">
        <PanelBody className="flex flex-col items-center gap-3 py-12 text-center">
          <Badge tone="neutral">{copy.featureLabel}</Badge>
          <h1 className="text-xl font-medium tracking-tight text-fg">
            {copy.title}
          </h1>
          <p className="max-w-sm text-sm text-fg-muted">{copy.description}</p>
          <Button asChild variant="secondary" size="sm">
            <Link href={copy.ctaHref}>{copy.ctaLabel}</Link>
          </Button>
        </PanelBody>
      </Panel>
    </div>
  );
}
