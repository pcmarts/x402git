-- An operator's verdict on whether a user is a test account (2026-09-14). See DECISIONS.md.
--
-- `/admin/users` works out "test" on its own — harness handles (`e2ea…`, `e2eb…`) and
-- users whose only on-chain activity is on a testnet — and this table is the override for
-- everything that rule gets wrong in either direction. A row is an explicit answer; no row
-- means the automatic one stands.
--
-- `subject` is `creator:<uuid>` for an account and `wallet:<lowercase address>` for a buyer
-- wallet, so one table covers both kinds of user and a handle is never the key.
--
-- Not a column on `creator`: buyer wallets have no row to put it on, and the label is an
-- operator's note about a user rather than a fact the user controls. Every change is also
-- an `event` row (`user_marked_test` / `user_marked_real`), so `/admin/audit` has the history
-- and this table only has to hold the current answer.

create table if not exists user_label (
  subject  text primary key check (subject ~ '^(creator:[0-9a-f-]{36}|wallet:0x[0-9a-f]{40})$'),
  is_test  boolean not null,
  set_by   text not null,
  set_at   timestamptz not null default now()
);

-- Same posture as `admin` and `ops_switch`: service role only.
alter table user_label enable row level security;
