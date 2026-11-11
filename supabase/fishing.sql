begin;

create schema if not exists fishing;
revoke all on schema fishing from public, anon, authenticated;

create table if not exists fishing.daily_scores (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  nickname text not null check (char_length(nickname) between 1 and 20),
  taskbar integer not null check (taskbar >= 0),
  compact integer not null check (compact >= 0),
  large integer not null check (large >= 0),
  primary key (user_id, day),
  check (taskbar::bigint * 10 + compact::bigint * 5 + large::bigint * 3 <= 1440)
);
create index if not exists daily_scores_day_idx on fishing.daily_scores (day);
alter table fishing.daily_scores enable row level security;
revoke all on fishing.daily_scores from public, anon, authenticated;

create or replace function public.fishing_submit(
  p_day date, p_nickname text, p_taskbar integer, p_compact integer, p_large integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  player uuid := auth.uid();
  name text := btrim(p_nickname);
begin
  if player is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_day is null or not isfinite(p_day) or p_day > (now() at time zone 'Asia/Shanghai')::date
     or name is null or char_length(name) not between 1 and 20 or name ~ '[[:cntrl:]]'
     or p_taskbar is null or p_taskbar < 0 or p_compact is null or p_compact < 0
     or p_large is null or p_large < 0
     or p_taskbar::bigint * 10 + p_compact::bigint * 5 + p_large::bigint * 3 not between 1 and 1440 then
    raise exception 'Invalid fishing score' using errcode = '22023';
  end if;
  insert into fishing.daily_scores as previous (user_id, day, nickname, taskbar, compact, large)
  values (player, p_day, name, p_taskbar, p_compact, p_large)
  on conflict (user_id, day) do update
  set nickname = excluded.nickname,
      taskbar = greatest(previous.taskbar, excluded.taskbar),
      compact = greatest(previous.compact, excluded.compact),
      large = greatest(previous.large, excluded.large);
end;
$$;

create or replace function public.fishing_leave()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from fishing.daily_scores where user_id = auth.uid();
$$;

create or replace function public.fishing_leaderboard(p_period text, p_offset integer default 0)
returns table (rank bigint, nickname text, fish bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with boundary as (
    select (now() at time zone 'Asia/Shanghai')::date as today
  ), totals as (
    select user_id,
           (array_agg(daily_scores.nickname order by day desc))[1] as name,
           sum(taskbar + compact + large) as total
    from fishing.daily_scores, boundary
    where day between case p_period
      when 'today' then today
      when 'week' then date_trunc('week', today::timestamp)::date
    end and today
    group by user_id
  )
  select rank() over (order by total desc), name, total
  from totals
  order by total desc, name, user_id
  limit 26 offset greatest(p_offset, 0);
$$;

revoke all on function public.fishing_submit(date, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.fishing_leave() from public, anon, authenticated;
revoke all on function public.fishing_leaderboard(text, integer) from public, anon, authenticated;
grant execute on function public.fishing_submit(date, text, integer, integer, integer) to authenticated;
grant execute on function public.fishing_leave() to authenticated;
grant execute on function public.fishing_leaderboard(text, integer) to anon, authenticated;

commit;
