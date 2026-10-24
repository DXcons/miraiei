-- ============================================================
-- 社員リスト（kintai_staff：月給・生年月日を含む）の閲覧を、管理者と勤怠タブレット（kiosk）に限定する
-- ＋ スタッフ用の共用アカウント（group_A/B/C）の表示名をメールアドレスから「Aグループ」等に変更する
-- （migration_2026-10-24b_onion_sign_names.sql の後に実行してください）
-- SupabaseのSQL Editorに貼り付けて「Run」を押してください
--
-- 社員リストを読んでいるのは：
--   ・管理画面（admin）　・勤怠打刻画面 kintai.html（kiosk）
--   ・PCのバックアップスクリプト（管理者アカウント oshmsakaikufa@gmail.com でログイン）
--   ・Edge Function（サービスロールのため影響なし）
--   ・玉ねぎ日報のサイン欄は staff_sign_names() 経由のため影響なし
-- ============================================================

drop policy if exists "ログイン済みユーザーは勤怠メンバーを閲覧できる" on public.kintai_staff;

create policy "管理者と勤怠タブレットのみ勤怠メンバーを閲覧できる"
  on public.kintai_staff for select
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'kiosk'))
  );

-- QRコードで名前を選ぶ画面・作業の割り当てに表示される名前
update public.profiles p set name = 'Aグループ'
  from auth.users u where u.id = p.id and u.email = 'group_A@farm.com';
update public.profiles p set name = 'Bグループ'
  from auth.users u where u.id = p.id and u.email = 'group_B@farm.com';
update public.profiles p set name = 'Cグループ'
  from auth.users u where u.id = p.id and u.email = 'group_C@farm.com';

-- ============================================================
-- 完了！
-- ============================================================
