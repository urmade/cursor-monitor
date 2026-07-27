-- Phase 1: organisations and users (Passport external_sub).

create table orgs (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  external_sub text not null unique,
  email text,
  display_name text,
  avatar_url text,
  last_seen_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index users_org_id_idx on users (org_id);
