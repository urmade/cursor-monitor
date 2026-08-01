import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComingSoonSplash } from '../components/ComingSoonSplash';
import {
  COMING_SOON_FEATURES,
  comingSoonCopy,
  type ComingSoonFeature,
} from './coming-soon';

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      ...props
    }: {
      href: string;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => React.createElement('a', { href, ...props }, children),
  };
});

describe('comingSoonCopy', () => {
  it.each(COMING_SOON_FEATURES)(
    'returns Coming soon copy for %s',
    (feature: ComingSoonFeature) => {
      const copy = comingSoonCopy(feature);
      expect(copy.title).toBe('Coming soon');
      expect(copy.description).toMatch(/deprecated for now and will be revisited later/i);
      expect(copy.ctaHref).toBe('/monitoring');
      expect(copy.featureLabel.length).toBeGreaterThan(0);
    },
  );
});

describe('ComingSoonSplash', () => {
  it.each(COMING_SOON_FEATURES)(
    'renders a splash for %s',
    (feature: ComingSoonFeature) => {
      const copy = comingSoonCopy(feature);
      const html = renderToStaticMarkup(
        createElement(ComingSoonSplash, { feature }),
      );
      expect(html).toContain('coming-soon-splash');
      expect(html).toContain(copy.title);
      expect(html).toContain(copy.description);
      expect(html).toContain(copy.featureLabel);
      expect(html).toContain(copy.ctaLabel);
      expect(html).toContain(`href="${copy.ctaHref}"`);
    },
  );
});
