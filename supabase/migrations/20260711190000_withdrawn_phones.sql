-- 탈퇴한 전화번호 기록 (로그인 실패 시 "탈퇴한 계정" 안내용)
create table if not exists public.withdrawn_phones (
  phone        text primary key,
  withdrawn_at timestamptz default now()
);

alter table public.withdrawn_phones enable row level security;
-- 정책 없음: REST로 직접 조회/수정 불가, 아래 security definer 함수로만 접근

-- 탈퇴 시 전화번호를 기록한 뒤 auth.users에서 실제 삭제 (profiles는 cascade)
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
begin
  select phone into v_phone from public.profiles where id = auth.uid();

  if v_phone is not null then
    insert into public.withdrawn_phones (phone) values (v_phone)
    on conflict (phone) do update set withdrawn_at = now();
  end if;

  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

-- 로그인 실패 시 "탈퇴한 계정인지" 확인용 (재가입했다면 false)
create or replace function public.is_withdrawn_phone(p_phone text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.withdrawn_phones w
    where w.phone = p_phone
      and not exists (select 1 from public.profiles p where p.phone = p_phone)
  );
$$;

revoke all on function public.is_withdrawn_phone(text) from public;
grant execute on function public.is_withdrawn_phone(text) to anon, authenticated;
