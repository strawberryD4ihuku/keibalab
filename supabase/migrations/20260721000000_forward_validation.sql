create table if not exists public.forward_predictions (
  snapshot_key text primary key,
  race_id text not null,
  strategy text not null check (strategy in ('stable', 'upset', 'upset_strict')),
  model_version text not null,
  race_date date not null,
  venue text,
  race_num integer,
  race_name text,
  recorded_at timestamptz not null default now(),
  odds_time text,
  decision text not null check (decision in ('buy', 'skip')),
  bet_type text not null,
  picks jsonb not null default '[]'::jsonb,
  invest integer not null default 0 check (invest >= 0),
  horse jsonb,
  signals jsonb not null default '{}'::jsonb,
  recorder uuid not null default auth.uid()
);

create table if not exists public.forward_results (
  snapshot_key text primary key references public.forward_predictions(snapshot_key),
  race_id text not null,
  strategy text not null,
  model_version text not null,
  settled_at timestamptz not null default now(),
  decision text not null,
  invest integer not null default 0,
  return_amount integer not null default 0,
  hit boolean not null default false,
  recorder uuid not null default auth.uid()
);

alter table public.forward_predictions enable row level security;
alter table public.forward_results enable row level security;

create or replace function public.stamp_forward_prediction()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.recorded_at := now();
  new.recorder := auth.uid();
  return new;
end;
$$;

create or replace function public.stamp_forward_result()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.settled_at := now();
  new.recorder := auth.uid();
  return new;
end;
$$;

drop trigger if exists stamp_forward_prediction_before_insert on public.forward_predictions;
create trigger stamp_forward_prediction_before_insert before insert on public.forward_predictions
for each row execute function public.stamp_forward_prediction();

drop trigger if exists stamp_forward_result_before_insert on public.forward_results;
create trigger stamp_forward_result_before_insert before insert on public.forward_results
for each row execute function public.stamp_forward_result();

drop policy if exists "forward predictions authenticated read" on public.forward_predictions;
create policy "forward predictions authenticated read" on public.forward_predictions
  for select to authenticated using (true);

drop policy if exists "forward predictions append only" on public.forward_predictions;
create policy "forward predictions append only" on public.forward_predictions
  for insert to authenticated with check (recorder = auth.uid() and race_date >= current_date);

drop policy if exists "forward results authenticated read" on public.forward_results;
create policy "forward results authenticated read" on public.forward_results
  for select to authenticated using (true);

drop policy if exists "forward results append only" on public.forward_results;
create policy "forward results append only" on public.forward_results
  for insert to authenticated with check (recorder = auth.uid());

grant select, insert on public.forward_predictions to authenticated;
grant select, insert on public.forward_results to authenticated;
