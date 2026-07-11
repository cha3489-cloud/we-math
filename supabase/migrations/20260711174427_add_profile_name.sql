-- 학생 이름 컬럼 추가
alter table public.profiles add column name text;

-- 회원가입 시 이름도 함께 저장하도록 트리거 갱신
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, phone, name)
  values (
    new.id,
    split_part(new.email, '@', 1),
    new.raw_user_meta_data ->> 'name'
  );
  return new;
end;
$$;
