-- Run this in the Supabase SQL Editor (New query, then Run)
-- Adds the Private Wealth / Investments / Savings split to existing goals

alter table goals add column category text not null default 'Savings';
