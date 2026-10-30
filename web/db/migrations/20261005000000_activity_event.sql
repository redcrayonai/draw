-- migrate:up
-- Activity feed and metric history drained from SpacetimeDB's activity_outbox
-- (web/src/lib/server/activity.ts). board.stats rows are the hourly/checkpoint
-- health snapshots. No board names: SpacetimeDB owns board metadata.
create table activity_event (
  id          bigserial primary key,
  db          text        not null,             -- SpacetimeDB database name
  outbox_id   bigint      not null,
  board_id    bigint      not null check (board_id >= 0),
  type        text        not null,
  actor       text        not null,             -- identity hex
  actor_name  text        not null default '',
  actor_kind  text        not null default 'human',
  at          timestamptz not null,
  last_at     timestamptz not null,
  count       integer     not null default 1,
  payload     jsonb       not null default '{}'::jsonb,
  unique (db, outbox_id, at)
);
create index activity_event_board_at on activity_event (db, board_id, at desc);

-- migrate:down
drop table activity_event;
