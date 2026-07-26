-- Phase 0 teardown (step 0.9). Drop disposable spike tables.

drop table if exists spike_run_tokens cascade;
drop table if exists spike_reports cascade;
drop table if exists spike_runs cascade;
drop table if exists spike_tickets cascade;
drop table if exists spike_meta cascade;
