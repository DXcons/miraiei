/* ==========================================================
   未来栄株式会社 図面管理システム  データのバックアップ(差分方式)
   ----------------------------------------------------------
   ・前回のバックアップから「増えた・変わった」ファイルだけをZIPにして、ボタンを押した人のPCにダウンロードする
     (図面・書類(請求書・納品書など)・取り込んだ注文書／御見積書)
   ・取引・明細・注文書のデータ・客先一覧などのデータ(小さい)は、毎回すべて入れる
   ・ZIPには「全ファイルの一覧表(CSV)」と「確認結果」を入れる。一覧表には、各ファイルがどのZIPに入っているかを書く
   ・ファイルごとに、分割した数と大きさが登録したときと合うかを確かめる。合わない物は確認結果に出し、次回も取り直す
   ・どのファイルをどのZIPに入れたかは Firestore の backups に記録する(誰のPCで取っても前回の続きから取れる)
   ・ログイン後のホームで、最後のバックアップから BACKUP_REMIND_DAYS 日以上たっていたら知らせる
   ・バックアップは社長のPCで社長が取る決まり。お知らせと「バックアップを取る」ボタンは、
     appUsers/{UID} に backup: true がある人(社長)にだけ出す(差分のZIPが1台にそろうように)
   使う部品：JSZip(backup.html で読み込む)。pdf-store.js(base64ToBlob, pad2 など)、order-store.js、case-store.js
   ========================================================== */

const BACKUP_COLLECTION = "backups";
const BACKUP_STATE_DOC = "state";
const BACKUP_REMIND_DAYS = 30;
// 1つのZIPの大きさの目安。これを超えるときはZIPを分ける(PCのメモリが足りなくならないように)
const BACKUP_PART_BYTES = 200 * 1024 * 1024;
const BACKUP_HISTORY_MAX = 24;

// ファイル本体を持つ置き場所
const BACKUP_FILE_SOURCES = [
  { col: "pdfDrawings", label: "図面" },
  { col: "orderFiles", label: "書類" },
  { col: "caseDocs", label: "取り込んだ注文書・御見積書" },
];
// データだけの置き場所(毎回すべて入れる)
const BACKUP_DATA_COLLECTIONS = ["orders", "caseItems", "purchaseOrders", "settings", "drawings"];

/* ---------- 前回の記録 ---------- */
async function fetchBackupState() {
  const doc = await db.collection(BACKUP_COLLECTION).doc(BACKUP_STATE_DOC).get();
  return doc.exists ? doc.data() : null;
}

// バックアップを取る係か(appUsers/{自分のUID} の backup が true)。
// 差分のZIPが1台のPC(社長のPC)にそろうよう、お知らせとボタンは係の人にだけ出す
async function isBackupOperator() {
  const u = auth.currentUser;
  if (!u) return false;
  try {
    const doc = await db.collection("appUsers").doc(u.uid).get();
    return doc.exists && doc.data().backup === true;
  } catch (err) {
    console.warn("バックアップの係かを確かめられませんでした", err);
    return false;
  }
}

// 最後のバックアップから何日たったか(一度も取っていなければ null)
function backupDaysSince(state) {
  if (!state || !state.lastAt || typeof state.lastAt.toMillis !== "function") return null;
  return Math.floor((Date.now() - state.lastAt.toMillis()) / 86400000);
}

/* ---------- 小さな道具 ---------- */
function backupTimeOf(v) {
  return v && typeof v.toMillis === "function" ? v.toMillis() : v ? String(v) : "";
}

// ファイルが変わったかを見分けるしるし(大きさ・分割数・登録日時・書き込み保存の日時)
function backupSig(d) {
  return [d.fileSize, d.chunkCount, backupTimeOf(d.createdAt), backupTimeOf(d.editedAt)].join("|");
}

// ファイル名・フォルダ名に使えない文字を除く
function backupSafeName(s, fallback) {
  const t = String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return (t || fallback).slice(0, 80);
}

// ZIPの中の置き場所：種類／客先／品番(品名)／ファイル名
function backupPathOf(col, d, ordersById) {
  const name = backupSafeName(d.fileName, d.id);
  if (col === "pdfDrawings") {
    return `図面/${backupSafeName(d.customer, "客先なし")}/${backupSafeName(d.productName || d.drawingNo, "品名なし")}/${name}`;
  }
  if (col === "caseDocs") return `取り込んだ注文書・御見積書/${backupSafeName(d.customer, "客先なし")}/${name}`;
  // 書類：orderId は「案件キー(case__客先グループ__品番)」か「取引のID」
  let customer = "", code = "";
  const m = /^case__(.*?)__(.*)$/.exec(d.orderId || "");
  if (m) {
    const g = CASE_CUSTOMER_GROUPS.find((x) => x.key === m[1]);
    customer = g ? g.label : m[1];
    code = m[2];
  } else {
    const o = ordersById.get(d.orderId);
    if (o) { customer = o.customer; code = o.caseCode || o.orderNo || ""; }
  }
  return `書類/${backupSafeName(customer, "客先不明")}/${backupSafeName(code, "品番なし")}/${backupSafeName(orderDocType(d), "その他")}_${name}`;
}

// 同じ置き場所が重なったら「(2)」を付ける
function backupUniquePath(path, used) {
  let p = path;
  for (let n = 2; used.has(p); n++) p = path.replace(/(\.[^./]*)?$/, ` (${n})$1`);
  used.add(p);
  return p;
}

// Firestoreの日時などを、JSONにできる形に直す
function backupPlain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(backupPlain);
  if (typeof v === "object") {
    const o = {};
    Object.keys(v).forEach((k) => (o[k] = backupPlain(v[k])));
    return o;
  }
  return v;
}

function backupCsvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function backupDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 分割保存されたファイルを取り出し、登録したときの分割数・大きさと合うかを確かめる
async function backupReadFile(col, d) {
  const snap = await db.collection(col).doc(d.id).collection("chunks").get();
  const parts = snap.docs.map((c) => c.data()).sort((a, b) => a.i - b.i);
  if (!parts.length) throw new Error("ファイルの本体が見つかりません");
  const problems = [];
  if (d.chunkCount && parts.length !== d.chunkCount) problems.push(`分割した数が合いません(記録 ${d.chunkCount}・実際 ${parts.length})`);
  if (parts.some((p, i) => p.i !== i)) problems.push("分割した一部が欠けています");
  const blob = base64ToBlob(parts.map((p) => p.data).join(""), d.mimeType || "application/octet-stream");
  if (d.fileSize && blob.size !== d.fileSize) problems.push(`大きさが合いません(記録 ${d.fileSize}・実際 ${blob.size} バイト)`);
  return { blob, problems };
}

/**
 * バックアップを取ってZIPをダウンロードする。
 * full: true なら前回の記録を使わず、すべてのファイルを入れる
 * onProgress(text): 進み具合の表示
 * 戻り値: { zips, added, addedBytes, kept, errors, deleted }
 */
async function runBackup({ full = false, onProgress = () => {} } = {}) {
  if (!window.JSZip) throw new Error("ZIPを作る部品を読み込めませんでした。インターネット接続を確認してください。");
  const now = new Date();
  const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  // 同じ分に2回取っても名前が重ならないよう秒まで入れる(重なるとブラウザが名前を変え、記録とずれる)
  const stamp = `${ymd}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const stampText = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const user = auth.currentUser ? auth.currentUser.email : "";

  // 前回までの記録(どのファイルをどのZIPに入れたか)
  onProgress("前回までの記録を読み込んでいます…");
  const manifests = {};
  for (const s of BACKUP_FILE_SOURCES) {
    const doc = await db.collection(BACKUP_COLLECTION).doc(`files_${s.col}`).get();
    manifests[s.col] = (doc.exists && doc.data().files) || {};
  }
  const firstTime = BACKUP_FILE_SOURCES.every((s) => !Object.keys(manifests[s.col]).length);
  const kind = full || firstTime ? "全部" : "差分";

  // データ(ファイルの一覧も含む)
  const data = {};
  for (const col of [...BACKUP_DATA_COLLECTIONS, ...BACKUP_FILE_SOURCES.map((s) => s.col)]) {
    onProgress(`データを読み込んでいます（${col}）…`);
    const snap = await db.collection(col).get();
    data[col] = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  const ordersById = new Map(data.orders.map((o) => [o.id, o]));

  // 入れるファイルを決める(前回と同じしるしの物は入れない)
  const todo = [];
  const rows = []; // 一覧表の行 { s, d, entry, note }
  const deleted = [];
  const nextManifests = {};
  for (const s of BACKUP_FILE_SOURCES) {
    const old = manifests[s.col];
    const next = (nextManifests[s.col] = {});
    for (const d of data[s.col]) {
      const sig = backupSig(d);
      const prev = old[d.id];
      if (kind === "差分" && prev && prev.sig === sig) {
        next[d.id] = prev;
        rows.push({ s, d, entry: prev, note: "前回までのZIPに入っています" });
      } else {
        todo.push({ s, d, sig, prev });
      }
    }
    const alive = new Set(data[s.col].map((d) => d.id));
    Object.entries(old).forEach(([id, e]) => !alive.has(id) && deleted.push({ s, id, entry: e }));
  }

  // ZIPの分け方を先に決める(名前に「1of2」などを付けるため)
  const groups = [[]];
  let acc = 0;
  for (const t of todo) {
    const size = t.d.fileSize || 0;
    if (acc + size > BACKUP_PART_BYTES && groups[groups.length - 1].length) {
      groups.push([]);
      acc = 0;
    }
    groups[groups.length - 1].push(t);
    acc += size;
  }
  const zipName = (i) => `未来栄バックアップ_${stamp}_${kind}${groups.length > 1 ? `_${i + 1}of${groups.length}` : ""}.zip`;

  const used = new Set();
  const errors = [];
  const zips = [];
  let added = 0, addedBytes = 0, done = 0;
  for (const [gi, group] of groups.entries()) {
    const zip = new JSZip();
    for (const t of group) {
      const { s, d, sig, prev } = t;
      onProgress(`ファイルを取り出しています… ${++done} / ${todo.length}（${d.fileName || d.id}）`);
      try {
        const { blob, problems } = await backupReadFile(s.col, d);
        const path = backupUniquePath(backupPathOf(s.col, d, ordersById), used);
        zip.file(path, blob);
        added++;
        addedBytes += blob.size;
        const entry = { sig, in: zipName(gi), path };
        if (problems.length) {
          // 中身は入れておくが、記録はしない(次回も取り直して確かめる)
          errors.push({ s, d, path, message: problems.join("、") });
          if (prev) nextManifests[s.col][d.id] = prev;
          rows.push({ s, d, entry, note: "要確認：" + problems.join("、") });
        } else {
          nextManifests[s.col][d.id] = entry;
          rows.push({ s, d, entry, note: prev ? "変更があったので入れ直しました" : "新しく入れました" });
        }
      } catch (err) {
        errors.push({ s, d, path: "", message: err.message || String(err) });
        if (prev) nextManifests[s.col][d.id] = prev;
        rows.push({ s, d, entry: prev || { in: "", path: "" }, note: "取り出せませんでした：" + (err.message || err) });
      }
    }

    // 最後のZIPに、データ・一覧表・確認結果を入れる
    if (gi === groups.length - 1) {
      BACKUP_DATA_COLLECTIONS.concat(BACKUP_FILE_SOURCES.map((s) => s.col)).forEach((col) => {
        zip.file(`データ/${col}.json`, JSON.stringify(backupPlain(data[col]), null, 1));
      });
      zip.file("全ファイルの一覧表.csv", "﻿" + backupListCsv(rows, ordersById));
      zip.file("確認結果.txt", backupReportText({
        stampText, user, kind, added, addedBytes, kept: rows.filter((r) => r.note === "前回までのZIPに入っています").length,
        errors, deleted, zipNames: groups.map((_, i) => zipName(i)),
      }));
    }

    onProgress(`ZIPを作っています…（${gi + 1} / ${groups.length}）`);
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    backupDownload(blob, zipName(gi));
    zips.push({ name: zipName(gi), size: blob.size });
  }

  // 記録を残す(ダウンロードまで終わってから)
  onProgress("記録を保存しています…");
  for (const s of BACKUP_FILE_SOURCES) {
    await db.collection(BACKUP_COLLECTION).doc(`files_${s.col}`).set({
      files: nextManifests[s.col],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }
  const state = (await fetchBackupState()) || {};
  const history = [{
    atText: stampText, by: user, kind, files: added, bytes: addedBytes, errors: errors.length,
    deleted: deleted.length, zips: zips.map((z) => z.name),
  }, ...(state.history || [])].slice(0, BACKUP_HISTORY_MAX);
  await db.collection(BACKUP_COLLECTION).doc(BACKUP_STATE_DOC).set({
    lastAt: firebase.firestore.FieldValue.serverTimestamp(),
    lastAtText: stampText,
    lastBy: user,
    history,
  });

  const kept = rows.filter((r) => r.note === "前回までのZIPに入っています").length;
  return { kind, zips, added, addedBytes, kept, errors, deleted };
}

function backupListCsv(rows, ordersById) {
  const head = ["種類", "客先", "品番・品名", "書類の種類", "ファイル名", "大きさ(バイト)", "登録日時", "登録した人", "入っているZIP", "ZIPの中の場所", "今回の状態", "ID"];
  const lines = rows.map(({ s, d, entry, note }) => {
    let customer = d.customer || "", code = d.productName || d.drawingNo || "";
    if (s.col === "orderFiles") {
      const parts = (entry.path || backupPathOf(s.col, d, ordersById)).split("/");
      customer = parts[1] || "";
      code = parts[2] || "";
    }
    return [
      s.label, customer, code, s.col === "orderFiles" ? orderDocType(d) : "", d.fileName || "", d.fileSize || "",
      d.createdAtText || (d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().toLocaleString("ja-JP") : ""),
      d.createdBy || "", entry.in || "", entry.path || "", note, `${s.col}/${d.id}`,
    ].map(backupCsvCell).join(",");
  });
  return [head.join(","), ...lines].join("\r\n");
}

function backupReportText(r) {
  const L = [];
  L.push("未来栄株式会社 図面管理システム　バックアップの確認結果");
  L.push("");
  L.push(`取った日時　：${r.stampText}`);
  L.push(`取った人　　：${r.user}`);
  L.push(`方式　　　　：${r.kind === "全部" ? "全部（すべてのファイルを入れました）" : "差分（前回から増えた・変わったファイルだけ）"}`);
  L.push(`ZIP　　　　 ：${r.zipNames.join("、")}`);
  L.push("");
  L.push(`このバックアップに入れたファイル：${r.added}件（${formatFileSize(r.addedBytes)}）`);
  if (r.kind === "差分") L.push(`前回までのZIPに入っているファイル（今回は入れていません）：${r.kept}件`);
  L.push(`確認で問題があったファイル：${r.errors.length}件`);
  r.errors.forEach((e) => L.push(`　・${e.s.label}　${e.d.fileName || e.d.id}：${e.message}`));
  if (r.errors.length) L.push("　→ 次回のバックアップでも取り直して確かめます。続くときはシステム管理者（酒井）に連絡してください。");
  L.push(`前回のバックアップのあとで削除されたファイル：${r.deleted.length}件`);
  r.deleted.forEach((x) => L.push(`　・${x.entry.path || x.id}（前回までのZIP「${x.entry.in || "?"}」に残っています）`));
  if (r.deleted.length >= 10) L.push("　→ 削除がとても多いです。心当たりがなければ、すぐにシステム管理者（酒井）に連絡してください。");
  L.push("");
  L.push("■ 大切なこと");
  L.push("・差分方式なので、これまでのZIPを全部残してください。1つでも無くすと、その中のファイルは戻せません。");
  L.push("・「全ファイルの一覧表.csv」の「入っているZIP」の列で、各ファイルがどのZIPにあるか分かります。");
  L.push("・取引・明細・注文書・客先一覧などのデータは「データ」フォルダに毎回すべて入っています（アプリへの戻し入れはシステム管理者（酒井）が行います）。");
  return L.join("\r\n");
}

/* ---------- ホームでのお知らせ ---------- */
// 最後のバックアップから BACKUP_REMIND_DAYS 日以上たっていたら知らせる(係の人だけ・同じタブでは1回だけ)
async function showBackupReminder() {
  if (sessionStorage.getItem("backupReminderShown")) return;
  if (!(await isBackupOperator())) return;
  let state;
  try {
    state = await fetchBackupState();
  } catch (err) {
    console.warn("バックアップの記録を確かめられませんでした", err);
    return;
  }
  const days = backupDaysSince(state);
  if (days !== null && days < BACKUP_REMIND_DAYS) return;
  sessionStorage.setItem("backupReminderShown", "1");

  const el = document.createElement("div");
  el.className = "modal-overlay open";
  el.innerHTML = `
    <div class="modal-box backup-remind">
      <div class="modal-head">
        <h3>⚠️ バックアップを取ってください</h3>
        <button type="button" class="modal-close" data-act="close" title="閉じる">&times;</button>
      </div>
      <div class="modal-body">
        <p class="backup-remind-main">${days === null
          ? "まだ一度もバックアップを取っていません。"
          : `最後のバックアップから <b>${days}日</b> たっています。<br><small>（${escapeHtml(state.lastAtText || "")}・${escapeHtml(state.lastBy || "")}）</small>`}</p>
        <p class="field-note">図面や請求書・納品書などを誤って消したときや、不正に消されたときに元に戻せるよう、
          月に1回はバックアップを取ってください。前回から増えた・変わった分だけを取るので、2回目からは短時間で終わります。</p>
      </div>
      <div class="modal-foot">
        <span></span>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" data-act="later">あとで取る（手順を開いておく）</button>
          <button type="button" class="btn btn-primary" data-act="now">今すぐバックアップを取る</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (ev) => {
    const act = ev.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "now") return (location.href = "backup.html?start=1");
    if (act.dataset.act === "later") window.open("backup.html#steps", "_blank");
    el.remove();
  });
}
