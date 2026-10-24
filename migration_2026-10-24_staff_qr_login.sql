-- ============================================================
-- スタッフ用QRコードログイン
-- 現場に貼ったQRコード（start.html?k=合言葉）を読み取ったスタッフが、
-- 名前を選ぶだけで本人としてログインできるようにする。
-- 合言葉はこのテーブルに1件だけ保存し、Edge Function（staff-qr-login）が照合する。
-- 管理者は staff_qr.html から QR の表示・印刷・作り直し（合言葉の変更）ができる。
-- SupabaseのSQL Editorに貼り付けて「Run」を押してください
-- ============================================================

create table public.staff_qr_keys (
  id         integer primary key default 1 check (id = 1),  -- 常に1行だけ
  key        text not null,
  updated_at timestamptz not null default now()
);

alter table public.staff_qr_keys enable row level security;

create policy "管理者のみQR合言葉を閲覧できる"
  on public.staff_qr_keys for select
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

create policy "管理者のみQR合言葉を変更できる"
  on public.staff_qr_keys for update
  using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- 初期の合言葉（ランダム32文字）
insert into public.staff_qr_keys (id, key)
values (1, replace(gen_random_uuid()::text, '-', ''));

-- ============================================================
-- 完了！
-- 次のステップ：Edge Function「staff-qr-login」をデプロイし、
-- 「Enforce JWT Verification（JWT検証）」をオフにしてください
-- ============================================================
