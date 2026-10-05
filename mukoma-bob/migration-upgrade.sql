-- Upgrade the existing ledger database without replacing its schema or data.
-- Safe to run more than once.

alter table public.goals
  add column if not exists category text not null default 'Savings';

alter table public.transactions
  add column if not exists occurred_time time,
  add column if not exists balance numeric,
  add column if not exists spend_group text,
  add column if not exists source_ref text;

create unique index if not exists transactions_source_ref_key
  on public.transactions (source_ref)
  where source_ref is not null;

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  total_amount numeric not null,
  remaining_amount numeric not null default 0,
  due_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Only approved people can see the ledger (the two existing accounts are added automatically)
create table if not exists public.ledger_members (
  user_id uuid primary key references auth.users(id)
);

insert into public.ledger_members (user_id)
select created_by from public.goals where created_by is not null
union
select created_by from public.transactions where created_by is not null
on conflict do nothing;

alter table public.ledger_members enable row level security;
alter table public.goals enable row level security;
alter table public.transactions enable row level security;
alter table public.debts enable row level security;

-- Remove the old "any logged-in user" policies so they stop letting new accounts in
do $$
declare p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('goals', 'transactions', 'debts', 'ledger_members')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end
$$;

create policy "read own membership" on public.ledger_members
  for select using (user_id = auth.uid());

create policy "members only goals" on public.goals
  for all using (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()))
  with check (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()));

create policy "members only transactions" on public.transactions
  for all using (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()))
  with check (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()));

create policy "members only debts" on public.debts
  for all using (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()))
  with check (exists (select 1 from public.ledger_members m where m.user_id = auth.uid()));

-- Fill in who created new rows automatically
alter table public.goals alter column created_by set default auth.uid();
alter table public.transactions alter column created_by set default auth.uid();
alter table public.debts alter column created_by set default auth.uid();
