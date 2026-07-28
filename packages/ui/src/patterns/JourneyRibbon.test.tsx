import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { JourneyRibbon } from './JourneyRibbon';

function node(
  seq: number,
  name: string,
  visitIndex = 1,
): {
  stageInstanceId: string;
  stageId: string;
  stageKey: string;
  stageName: string;
  visitIndex: number;
  seq: number;
  costMicroUsd: string;
  isRework: boolean;
} {
  return {
    stageInstanceId: `si-${seq}`,
    stageId: `st-${name}`,
    stageKey: name.toLowerCase(),
    stageName: name,
    visitIndex,
    seq,
    costMicroUsd: visitIndex > 1 ? '100000' : '0',
    isRework: visitIndex > 1,
  };
}

describe('JourneyRibbon snapshots', () => {
  it('zero loops — plain line', () => {
    const html = renderToStaticMarkup(
      createElement(JourneyRibbon, {
        nodes: [node(1, 'Intake'), node(2, 'Impl'), node(3, 'Review')],
        arcs: [],
        accessibleSummary: 'Path: Intake → Impl → Review.',
      }),
    );
    expect(html).toContain('Intake');
    expect(html).not.toContain('↺');
    expect(html).toMatchSnapshot();
  });

  it('one loop', () => {
    const html = renderToStaticMarkup(
      createElement(JourneyRibbon, {
        nodes: [
          node(1, 'Intake'),
          node(2, 'Impl'),
          node(3, 'Review'),
          node(4, 'Impl', 2),
        ],
        arcs: [
          {
            loopEdgeId: 'e1',
            fromSeq: 3,
            toSeq: 4,
            reasonCode: 'review_findings',
            costMicroUsd: '4100000',
            costComplete: true,
          },
        ],
        accessibleSummary: 'one return',
      }),
    );
    expect(html).toContain('review_findings');
    expect(html).toMatchSnapshot();
  });

  it('five loops collapses pairs', () => {
    const arcs = Array.from({ length: 5 }, (_, i) => ({
      loopEdgeId: `e${i}`,
      fromSeq: i,
      toSeq: i + 1,
      reasonCode: 'review_findings',
      costMicroUsd: '1000',
      costComplete: true,
    }));
    const html = renderToStaticMarkup(
      createElement(JourneyRibbon, {
        nodes: [node(1, 'Impl'), node(2, 'Review'), node(3, 'Impl', 2)],
        arcs,
        collapsedPairs: [
          {
            fromStageKey: 'review',
            toStageKey: 'implementation',
            count: 5,
            reasonCodes: ['review_findings'],
          },
        ],
        accessibleSummary: 'five returns',
      }),
    );
    expect(html).toContain('×5');
    expect(html).toMatchSnapshot();
  });

  it('twenty loops still legible via collapsed pairs', () => {
    const arcs = Array.from({ length: 20 }, (_, i) => ({
      loopEdgeId: `e${i}`,
      fromSeq: i,
      toSeq: i + 1,
      reasonCode: i % 2 ? 'spec_gap' : 'review_findings',
      costMicroUsd: null,
      costComplete: false,
    }));
    const html = renderToStaticMarkup(
      createElement(JourneyRibbon, {
        nodes: [node(1, 'A'), node(2, 'B', 2)],
        arcs,
        collapsedPairs: [
          {
            fromStageKey: 'a',
            toStageKey: 'b',
            count: 20,
            reasonCodes: ['review_findings', 'spec_gap'],
          },
        ],
        accessibleSummary: 'twenty returns',
      }),
    );
    expect(html).toContain('×20');
    expect(html).toMatchSnapshot();
  });
});
