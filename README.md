# 未来栄株式会社 図面管理システム（モック）

未来栄株式会社向けWebアプリのUIモックです。画面・作図機能は引き続きモックですが、
**ログイン認証と図面データはFirebase（Authentication + Firestore）を使った実データ**になっています。

## 画面構成

| ファイル | 画面 |
|---|---|
| [login.html](login.html) | ログイン画面（Firebase Authに登録済みのメールアドレス・パスワードでログイン） |
| [home.html](home.html) | ログイン後のホーム（「過去の図面をさがす」「新しい図面をつくる」） |
| [search.html](search.html) | 図面検索画面（屋外/室内、樹脂/金属、部品名、寸法での絞り込み＋該当件数表示） |
| [detail.html](detail.html) | 図面詳細画面（検索結果クリックで遷移。図面情報＋「必要な材料」一覧を表形式で表示） |
| [new.html](new.html) | 新規作成画面（「過去の図面をコピーして編集する」→検索ポップアップ／「ゼロから作る」） |
| [edit.html](edit.html) | 図面編集画面（プレースホルダー。実際の作図UIは未実装） |
| [seed.html](seed.html) | 初回データ投入用（管理者がセットアップ時に1回だけ使う。投入後は削除する） |

## セットアップ（Firebase連携）

1. [Firebaseコンソール](https://console.firebase.google.com/) で新規プロジェクトを作成する。
2. **構築 > Authentication** を開き、「始める」→ ログイン方法で **メール/パスワード** を有効化する。
   （本アプリにサインアップ画面はないため、利用者アカウントは次の手順でしか作られません）
3. **Authentication > Users** タブから「ユーザーを追加」で、利用者ごとにメールアドレス／パスワードを登録する。
4. **構築 > Firestore Database** を開き、「データベースの作成」（本番環境モードで作成）。
5. Firestoreの **ルール** タブを開き、いったん以下の内容に置き換えて「公開」する（データ投入のため一時的に書き込みを許可）。
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /drawings/{drawingId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
6. **プロジェクトの設定(歯車アイコン) > 全般** の「マイアプリ」でウェブアプリを追加し、表示された`firebaseConfig`の値を
   [`js/firebase-config.js`](js/firebase-config.js) に貼り付ける。
7. 変更をコミットしてGitHubへpush（GitHub Pagesに反映されるまで数分待つ）。
8. 公開されたサイトで手順3のアカウントでログインし、`seed.html` を開いて「ダミーデータ12件を投入する」を実行する。
9. 投入完了後、`seed.html` を削除し、Firestoreのルールを [`firebase/firestore.rules`](firebase/firestore.rules) の内容
   （読み取り専用）に戻して再度「公開」する。

`js/firebase-config.js` の値はクライアント側に公開される前提の識別子です。データの保護はFirestoreの
セキュリティルール（`drawings`はログイン済みユーザーのみ閲覧可・書き込み不可）で行っているため、
リポジトリに含めても問題ありません。

## 使い方

`login.html` をブラウザで開いてください（`index.html` からも遷移します）。
セットアップ手順3で作成したメールアドレス・パスワードでログインします。
ローカルファイルとして開く場合も動作しますが、Firebase接続のため通信環境が必要です。

## 検索条件の項目

- 設置場所：屋外／室内（単一選択）
- 材質：樹脂／金属（複数選択）
- 部品名：プーリー／ローラー／ベルト／調芯／その他（複数選択）
- ロールの寸法：直径・長さ（それぞれ下限〜上限の範囲指定）
- コンベヤの寸法：幅・長さ（それぞれ下限〜上限の範囲指定）

検索条件の変更に応じて「該当する図面の数」がリアルタイムに更新されます。
図面データはFirestoreの `drawings` コレクションから取得します（内容は [`seed.html`](seed.html) 参照、値はダミーです）。

## 注意事項

- ログイン認証・図面データの閲覧はFirebaseによる実データですが、図面の新規作成・編集・保存機能は
  引き続きプレースホルダー（[edit.html](edit.html)）であり、実際の作図・DB書き込みは行われません。
- ログイン状態はFirebase Authのセッション（ブラウザのローカルストレージ）で管理されます。
