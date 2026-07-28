import { describe, expect, it } from 'vitest';
import { listRegisteredKinds } from './registry';
import './handlers';

describe('job handlers registry', () => {
  it('registers phase 9 analytics and backtest handlers', () => {
    const kinds = listRegisteredKinds();
    expect(kinds).toContain('compute_analytics_daily');
    expect(kinds).toContain('run_estimate_backtest');
    expect(kinds).toContain('dispatch_webhook_events');
    expect(kinds).toContain('poll_run');
  });
});
