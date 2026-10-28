-- PrismHR roster test: Supabase schema
-- Run once in Supabase > SQL Editor.
-- Row Level Security is ON with NO policies, so the public "anon"/publishable key
-- can read nothing. Only server-side code holding the secret/service key can read or write.

create table if not exists public.prism_employees (
  client_id    text        not null,
  employee_id  text        not null,
  first_name   text,
  last_name    text,
  job_title    text,
  status       text,
  hire_date    text,          -- kept as text: PrismHR date formats vary
  synced_at    timestamptz not null default now(),
  primary key (client_id, employee_id)
);

create table if not exists public.prism_sync_runs (
  id             bigserial primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  client_id      text,
  ok             boolean,
  employee_count integer,
  message        text,
  field_names    text        -- names of fields PrismHR returned (no values), used for mapping
);

alter table public.prism_employees enable row level security;
alter table public.prism_sync_runs enable row level security;

-- Belt and braces: remove any default grants to the public roles.
revoke all on public.prism_employees from anon, authenticated;
revoke all on public.prism_sync_runs from anon, authenticated;

-- Only the server-side secret key (service_role) may use these tables.
grant select, insert, update, delete on public.prism_employees to service_role;
grant select, insert, update, delete on public.prism_sync_runs to service_role;
grant usage, select on sequence public.prism_sync_runs_id_seq to service_role;

-- "Refresh now" requests from the website; the sync server checks for pending ones every minute.
create table if not exists public.prism_sync_requests (
  id            bigserial primary key,
  requested_at  timestamptz not null default now(),
  requested_by  text,
  status        text not null default 'pending',   -- pending | running | done | failed
  processed_at  timestamptz,
  message       text
);
alter table public.prism_sync_requests enable row level security;
revoke all on public.prism_sync_requests from anon, authenticated;
grant select, insert, update, delete on public.prism_sync_requests to service_role;
grant usage, select on sequence public.prism_sync_requests_id_seq to service_role;
