export const COMING_SOON_FEATURES = ['inbox', 'projects'] as const;

export type ComingSoonFeature = (typeof COMING_SOON_FEATURES)[number];

export type ComingSoonCopy = {
  featureLabel: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
};

const COPY: Record<ComingSoonFeature, ComingSoonCopy> = {
  inbox: {
    featureLabel: 'Inbox',
    title: 'Coming soon',
    description:
      'Inbox is deprecated for now and will be revisited later.',
    ctaLabel: 'Go to Monitoring',
    ctaHref: '/monitoring',
  },
  projects: {
    featureLabel: 'Projects',
    title: 'Coming soon',
    description:
      'Projects is deprecated for now and will be revisited later.',
    ctaLabel: 'Go to Monitoring',
    ctaHref: '/monitoring',
  },
};

export function comingSoonCopy(feature: ComingSoonFeature): ComingSoonCopy {
  return COPY[feature];
}
