-- 학생 프로필 테이블
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  phone       text unique not null,
  created_at  timestamptz default now()
);

alter table public.profiles enable row level security;

-- 본인 프로필만 조회/수정 가능
create policy "본인 조회" on public.profiles
  for select using (auth.uid() = id);

create policy "본인 수정" on public.profiles
  for update using (auth.uid() = id);

-- 회원가입 시 프로필 자동 생성 트리거
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, phone)
  values (
    new.id,
    split_part(new.email, '@', 1)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
