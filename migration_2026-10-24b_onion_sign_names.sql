-- ============================================================
-- 玉ねぎ日報の「サイン」欄を社員リスト（kintai_staff）から選べるようにする
-- ＋ QRコードでだれでもスタッフとしてログインできるようになるため、時給の閲覧を管理者のみに絞る
-- （migration_2026-10-24_staff_qr_login.sql の後に実行してください）
-- SupabaseのSQL Editorに貼り付けて「Run」を押してください
-- ============================================================

-- サイン欄用：在籍中メンバーの「呼び名・国籍」だけを返す（生年月日・月給などは返さない）
create or replace function public.staff_sign_names()
returns table (id uuid, name text, category text)
language sql
security definer
set search_path = public
stable
as $$
  select id, name, category
  from public.kintai_staff
  where active
  order by sort_order, name;
$$;

revoke all on function public.staff_sign_names() from public, anon;
grant execute on function public.staff_sign_names() to authenticated;

-- 時給：これまでログイン済みならだれでも閲覧できたが、管理者のみに変更
-- （読んでいるのは管理画面と日次レポートのEdge Function（サービスロールのため影響なし）だけ）
drop policy if exists "ログイン済みユーザーは時給を閲覧できる" on public.kintai_hourly_wages;

create policy "管理者のみ時給を閲覧できる"
  on public.kintai_hourly_wages for select
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ============================================================
-- 完了！
-- ============================================================
