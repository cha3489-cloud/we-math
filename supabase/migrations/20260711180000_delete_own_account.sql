-- 본인 계정 탈퇴용 RPC (auth.users 삭제 → profiles는 cascade로 함께 삭제됨)
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
