import type { Pool } from "pg";

export const SCHEMA_NAME = "fluxometer";

const MIGRATION_SQL = `
create schema if not exists ${SCHEMA_NAME};

create table if not exists ${SCHEMA_NAME}.request_metrics (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  route text not null,
  method text not null,
  status int not null,
  duration_ms int not null,
  user_hash text,
  platform text
);
create index if not exists request_metrics_created_at_idx
  on ${SCHEMA_NAME}.request_metrics (created_at);
create index if not exists request_metrics_route_created_at_idx
  on ${SCHEMA_NAME}.request_metrics (route, created_at);

create table if not exists ${SCHEMA_NAME}.client_metrics (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  screen text not null,
  action text not null,
  duration_ms int not null,
  app_version text,
  platform text
);

-- One row per failed (4xx/5xx) request of a matched route, with the cause.
-- request_metrics says THAT it failed; this says why and for whom.
create table if not exists ${SCHEMA_NAME}.request_failures (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  route text not null,
  method text not null,
  status int not null,
  duration_ms int,
  error_name text,
  error_code text,
  message text,
  correlation_id text,
  tenant text,
  user_hash text,
  platform text
);
create index if not exists request_failures_created_at_idx
  on ${SCHEMA_NAME}.request_failures (created_at);
create index if not exists request_failures_status_created_at_idx
  on ${SCHEMA_NAME}.request_failures (status, created_at);
create index if not exists request_failures_route_created_at_idx
  on ${SCHEMA_NAME}.request_failures (route, created_at);

-- Generic "something changed" trail. Field NAMES only, never values.
create table if not exists ${SCHEMA_NAME}.audit_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  entity text not null,
  action text not null,
  target_id text,
  affected_count int,
  tenant text,
  actor text,
  source text,
  route text,
  method text,
  correlation_id text,
  fields text[],
  effect text,
  tags text[]
);
create index if not exists audit_events_created_at_idx
  on ${SCHEMA_NAME}.audit_events (created_at);
create index if not exists audit_events_tenant_created_at_idx
  on ${SCHEMA_NAME}.audit_events (tenant, created_at);
create index if not exists audit_events_effect_created_at_idx
  on ${SCHEMA_NAME}.audit_events (effect, created_at);
create index if not exists audit_events_entity_created_at_idx
  on ${SCHEMA_NAME}.audit_events (entity, created_at);

create table if not exists ${SCHEMA_NAME}.ai_calls (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  model text not null,
  duration_ms int not null,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10, 6),
  tools_called text[],
  success boolean not null,
  user_hash text
);

create table if not exists ${SCHEMA_NAME}.deploy_markers (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  deploy_id text not null
);

-- One row per daily-report attempt (ok / failed / rejected) plus one per
-- stale-report alert sent, so fluxometer can tell when the report stopped
-- arriving and why.
create table if not exists ${SCHEMA_NAME}.report_runs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  status text not null,
  detail text
);
create index if not exists report_runs_status_created_at_idx
  on ${SCHEMA_NAME}.report_runs (status, created_at);
`;

export async function runMigration(pool: Pool): Promise<void> {
  await pool.query(MIGRATION_SQL);
}
