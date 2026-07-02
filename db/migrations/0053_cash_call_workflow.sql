-- 0053: cash-call priority payment workflow (industry gap analysis Tier-1 #5).
--
-- Large-loss cash calls need a governed release: requested -> approved (by a
-- DIFFERENT user - maker/checker) -> paid, with a priority so a live cat's
-- simultaneous settlements jump the queue. Additive and idempotent.

alter table cash_call
  add column if not exists priority text not null default 'NORMAL'
    check (priority in ('NORMAL','URGENT','SIMULTANEOUS_SETTLEMENT')),
  add column if not exists approved_by uuid references app_user(id),
  add column if not exists approved_at timestamptz,
  add column if not exists paid_at timestamptz;

-- Widen the status lifecycle: requested -> approved -> paid | rejected.
alter table cash_call drop constraint if exists cash_call_status_check;
alter table cash_call
  add constraint cash_call_status_check
  check (status in ('requested','approved','paid','rejected'));

create index if not exists cash_call_queue_idx
  on cash_call (tenant_id, status, priority, requested_date);
