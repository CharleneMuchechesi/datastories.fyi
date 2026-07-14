-- Mukoma Bob's Ledger — database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run

-- Goals (savings targets)
create table goals (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  target_amount numeric not null,
  current_amount numeric not null default 0,
  target_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Transactions (income + expenses)
create table transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('income', 'expense')),
  category text not null,
  amount numeric not null,
  occurred_on date not null default current_date,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Lock both tables down: only logged-in users (you two) can touch them.
-- This works because sign-ups will be disabled, so the ONLY accounts that
-- can ever exist are the ones you create by hand in the Auth tab.
alter table goals enable row level security;
alter table transactions enable row level security;

create policy "authenticated read goals" on goals
  for select using (auth.role() = 'authenticated');
create policy "authenticated write goals" on goals
  for insert with check (auth.role() = 'authenticated');
create policy "authenticated update goals" on goals
  for update using (auth.role() = 'authenticated');
create policy "authenticated delete goals" on goals
  for delete using (auth.role() = 'authenticated');

create policy "authenticated read transactions" on transactions
  for select using (auth.role() = 'authenticated');
create policy "authenticated write transactions" on transactions
  for insert with check (auth.role() = 'authenticated');
create policy "authenticated update transactions" on transactions
  for update using (auth.role() = 'authenticated');
create policy "authenticated delete transactions" on transactions
  for delete using (auth.role() = 'authenticated');
