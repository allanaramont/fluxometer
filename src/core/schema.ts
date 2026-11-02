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
`;

export async function runMigration(pool: Pool): Promise<void> {
  await pool.query(MIGRATION_SQL);
}
