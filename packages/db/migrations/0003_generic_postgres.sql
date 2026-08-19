-- Authentication is enforced by the application. The baseline schema must not
-- depend on provider-owned database roles or row-level-security policies.
alter table monitor_hook_events disable row level security;
alter table monitor_team_usage_events disable row level security;
alter table monitor_repository_preferences disable row level security;
alter table monitor_conversation_preferences disable row level security;
alter table monitor_branch_preferences disable row level security;
alter table monitor_sync_runs disable row level security;
alter table monitor_sync_locks disable row level security;
