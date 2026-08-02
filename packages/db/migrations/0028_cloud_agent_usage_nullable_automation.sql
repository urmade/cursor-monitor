-- Broaden automation usage tables to store all Cloud Agent runs from
-- filtered-usage-events (cloudAgentId: "*"), not only automation-attributed ones.

alter table automation_usage_events
  alter column automation_id drop not null;

alter table automation_agent_runs
  alter column automation_id drop not null;

-- Prefer looking up by cloud agent id (primary key for this ledger).
create index if not exists automation_usage_events_org_agent
  on automation_usage_events (org_id, cloud_agent_id, event_timestamp desc)
  where cloud_agent_id is not null;

comment on table automation_agent_runs is
  'Cadence-synced Cloud Agent runs from Admin filtered-usage-events (cloudAgentId: *). automation_id set when the run was automation-launched.';
