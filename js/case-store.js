/* ==========================================================
   未来栄株式会社 図面管理システム  案件(品番)ごとの受注・外注単価の突き合わせ
   ----------------------------------------------------------
   注文書(客先→未来栄)と御見積書(外注先→未来栄)を図面番号で突き合わせた
   1行(=図面1枚)を caseItems に1ドキュメントとして保存する。

     caseItems/{id}            … 品番・品名・図面番号・受注単価・外注単価など
     pdfDrawings/{id}          … 図面(1枚ずつのPDF)。「図面を保存する」と同じ置き場所
     caseDocs/{id}/chunks/…    … 元の注文書・御見積書のPDF

   データはPDFを読み取って作った取り込み用ファイル(JSON)から
   case-import.html で登録する。pdf-store.js の分割保存の仕組みを使う。
   ========================================================== */

const CASE_ITEM_COLLECTION = "caseItems";
const CASE_DOC_COLLECTION = "caseDocs";
const CASE_IMPORT_FORMAT = "miraiei-case-import";

/* ---------- 客先のグループ ----------
   「過去の案件を管理する」で最初に選ぶカード。aliasesは表記ゆれの吸収用。
   どれにも当てはまらない客先は「その他」に入る。
   codeLabel は表の「品番」列の呼び方(注文番号で管理する客先もある)。

   客先・外注先の名前は公開ファイルに書かず、Firestoreの settings/partners に保存する。
   各ページの initPage() が loadPartners() を呼んで、下の配列を中身ごと入れ替える。
   (partners.html で編集する) */
const CASE_OTHER_GROUP = "その他";
const CASE_OTHER_INFO = { key: CASE_OTHER_GROUP, label: "その他", sub: "", aliases: [], codeLabel: "品番" };
const CASE_CUSTOMER_GROUPS = [CASE_OTHER_INFO];

// 外注先・材料屋 { name, short, tel, address }（注文書の宛先の候補）
const PARTNER_VENDORS = [];
// 納品書の宛名(客先グループ → 正式名)
const CUSTOMER_FORMAL_NAMES = {};

const PARTNERS_COLLECTION = "settings";
const PARTNERS_DOC_ID = "partners";
let PARTNERS_LOADED = false;
let PARTNERS_ERROR = "";

// 画面で編集できる形(partners)を整えて返す
function normalizePartners(raw) {
  const str = (v) => String(v == null ? "" : v).trim();
  const customers = (raw && Array.isArray(raw.customers) ? raw.customers : [])
    .map((c) => ({
      key: str(c.key),
      label: str(c.label) || str(c.key),
      sub: str(c.sub),
      formalName: str(c.formalName),
      codeLabel: str(c.codeLabel) || "品番",
      aliases: (Array.isArray(c.aliases) ? c.aliases : []).map(str).filter(Boolean),
    }))
    .filter((c) => c.key && c.key !== CASE_OTHER_GROUP);
  const vendors = (raw && Array.isArray(raw.vendors) ? raw.vendors : [])
    .map((v) => ({ name: str(v.name), short: str(v.short), tel: str(v.tel), address: str(v.address) }))
    .filter((v) => v.name);
  return { customers, vendors };
}

// 読み込んだ内容を、各ページが参照している配列に反映する(配列そのものは差し替えない)
function applyPartners(partners) {
  const p = normalizePartners(partners);
  CASE_CUSTOMER_GROUPS.length = 0;
  p.customers.forEach((c) => CASE_CUSTOMER_GROUPS.push({
    key: c.key, label: c.label, sub: c.sub, codeLabel: c.codeLabel,
    aliases: Array.from(new Set([c.key, c.label, ...c.aliases])),
  }));
  CASE_CUSTOMER_GROUPS.push(CASE_OTHER_INFO);
  PARTNER_VENDORS.length = 0;
  p.vendors.forEach((v) => PARTNER_VENDORS.push(v));
  Object.keys(CUSTOMER_FORMAL_NAMES).forEach((k) => delete CUSTOMER_FORMAL_NAMES[k]);
  p.customers.forEach((c) => { if (c.formalName) CUSTOMER_FORMAL_NAMES[c.key] = c.formalName; });
}

async function fetchPartners() {
  const doc = await db.collection(PARTNERS_COLLECTION).doc(PARTNERS_DOC_ID).get();
  return normalizePartners(doc.exists ? doc.data() : null);
}

async function savePartners(partners) {
  const p = normalizePartners(partners);
  await db.collection(PARTNERS_COLLECTION).doc(PARTNERS_DOC_ID).set({
    ...p,
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  applyPartners(p);
  return p;
}

// ログイン後に各ページの initPage() から呼ばれる。失敗してもページは動かす(客先は「その他」だけになる)
async function loadPartners() {
  try {
    applyPartners(await fetchPartners());
    PARTNERS_LOADED = true;
    PARTNERS_ERROR = "";
  } catch (err) {
    console.warn("客先・外注先の一覧を読み込めませんでした", err);
    PARTNERS_ERROR = "客先・外注先の一覧を読み込めませんでした。画面を再読み込みしてください。";
    if (typeof toast === "function") toast(PARTNERS_ERROR);
  }
}

function caseGroupInfo(groupKey) {
  return CASE_CUSTOMER_GROUPS.find((g) => g.key === groupKey) || CASE_CUSTOMER_GROUPS[CASE_CUSTOMER_GROUPS.length - 1];
}

function caseCodeLabel(groupKey) {
  return caseGroupInfo(groupKey).codeLabel;
}

// 全角英数・アポストロフィの違い・空白・「株式会社」を無視して比べる
function normalizeCustomerName(name) {
  return String(name || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[’‘`´＇]/g, "'")
    .replace(/株式会社|\(株\)|（株）|㈱/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function customerGroupOf(customerName) {
  const n = normalizeCustomerName(customerName);
  const hit = CASE_CUSTOMER_GROUPS.find((g) => g.aliases.some((a) => normalizeCustomerName(a) === n));
  return hit ? hit.key : CASE_OTHER_GROUP;
}

/* ---------- 表示用ヘルパー ---------- */

function formatYen(value) {
  if (value === null || value === undefined || value === "" || isNaN(value)) return "-";
  return "¥" + Number(value).toLocaleString("ja-JP");
}

// "2026-06-02" → 「2026/6/2」
function formatCaseDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : value || "-";
}

/* ---------- 外注の内訳 ----------
   1つの部品に外注先が複数ある(材料・熱処理・加工など)場合は costs に1工程1行で持つ。
   外注単価は costs の単価(1個あたり)の合計。材料費・運賃も出ていくお金なので含める。
   ただし kind:"reference" の行(見積はもらったが発注しなかった先など)は参考表示のみで合計しない。
   CAM'Sのように1社だけなら costs は空。 */
function caseCostLines(item) {
  return Array.isArray(item.costs) && item.costs.length ? item.costs : [];
}

function isReferenceCost(c) {
  return c.kind === "reference";
}

function sumCostLines(costs) {
  return costs.filter((c) => !isReferenceCost(c)).reduce((t, c) => t + (Number(c.unitPrice) || 0), 0);
}

// 実際に支払う外注先(参考行は除く)
function costVendors(costs) {
  return Array.from(new Set(costs.filter((c) => !isReferenceCost(c)).map((c) => c.vendor).filter(Boolean)));
}

// 表に出す外注先。複数なら「金太 ほか3社」
function outsourcerLabel(item) {
  const vendors = costVendors(caseCostLines(item));
  if (vendors.length > 1) return `${vendors[0]} ほか${vendors.length - 1}社`;
  return vendors[0] || item.outsourcer || "";
}

/* ---------- 検索(英語表記とカタカナの両方でヒットさせる) ----------
   図面の品名は「SHAFT」のような英語のこともあるので、よく使う部品名は
   カタカナに置き換えたものでも照合する。足りない単語はここに追加する。 */
const PART_NAME_EN_TO_KANA = {
  SHAFT: "シャフト", COLLAR: "カラー", PLATE: "プレート", BRACKET: "ブラケット", PIN: "ピン",
  GEAR: "ギア", BUSH: "ブッシュ", BUSHING: "ブッシュ", SPACER: "スペーサー", COVER: "カバー",
  BASE: "ベース", BLOCK: "ブロック", HOLDER: "ホルダ", FLANGE: "フランジ", KEY: "キー",
  ROLLER: "ローラー", ROLL: "ロール", PULLEY: "プーリー", NUT: "ナット", BOLT: "ボルト",
  WASHER: "ワッシャ", SLEEVE: "スリーブ", BEARING: "ベアリング", STAY: "ステー", GUIDE: "ガイド",
  RAIL: "レール", STOPPER: "ストッパー", LEVER: "レバー", ARM: "アーム", CASE: "ケース",
  HOUSING: "ハウジング", STAND: "スタンド", FRAME: "フレーム", SUPPORT: "サポート", JOINT: "ジョイント",
  CAM: "カム", SPROCKET: "スプロケット", CHAIN: "チェーン", SPRING: "スプリング", RING: "リング",
  SCREW: "スクリュー", CLAMP: "クランプ", SLIDER: "スライダ", HUB: "ハブ", CAP: "キャップ",
  DISK: "ディスク", DISC: "ディスク", WHEEL: "ホイール", AXLE: "アクスル", PISTON: "ピストン",
  ROD: "ロッド", CYLINDER: "シリンダ", MOTOR: "モーター", TABLE: "テーブル", BAR: "バー",
  CUTTER: "カッター", BLADE: "ブレード", NOZZLE: "ノズル", SHIM: "シム", LINER: "ライナー",
};

// 半角カナ・全角英数・ひらがな・長音や記号の違いを吸収して比べられる形にする
function searchNormalize(s) {
  return String(s || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .replace(/[\s\-ー‐－・_.,'’]/g, "");
}

// 1つの文字列から、照合に使う形を(英語のまま・カタカナに置き換えたもの)の両方作る
function searchForms(s) {
  const raw = String(s || "").normalize("NFKC").toUpperCase();
  const kana = raw.replace(/[A-Z]+/g, (w) => PART_NAME_EN_TO_KANA[w] || w);
  return Array.from(new Set([searchNormalize(raw), searchNormalize(kana)]));
}

// fields(品名・図面番号など)のどれかが、query を含んでいればtrue
function matchesSearch(fields, query) {
  const qs = searchForms(query).filter(Boolean);
  if (!qs.length) return true;
  return fields.some((f) => searchForms(f).some((form) => qs.some((q) => form.includes(q))));
}

// 粗利率(%)。受注単価が無いときはnull
function marginRate(orderPrice, outsourcePrice) {
  if (!orderPrice || outsourcePrice === null || outsourcePrice === undefined || outsourcePrice === "") return null;
  return ((orderPrice - outsourcePrice) / orderPrice) * 100;
}

/* ---------- ドキュメントID ----------
   同じファイルを取り込み直したときに二重登録にならないよう、内容から決まるIDにする。
   Firestoreのドキュメントidに「/」は使えないため置き換える。 */
function caseSafeId(parts) {
  return parts.map((p) => String(p || "").replace(/[\/\s]/g, "_")).join("__");
}

function caseItemId(customer, item) {
  return caseSafeId(["item", customer, item.productCode, item.drawingNo, item.orderSlipNo]);
}

// 図面は図面番号ごとに1つ。別の注文で同じ図面が出てきても使い回す
function caseDrawingId(customer, item) {
  return caseSafeId(["case", customer, item.productCode, item.drawingNo]);
}

function caseDocId(customer, sourceFile) {
  return caseSafeId(["doc", customer, sourceFile]);
}

/* ---------- 読み出し ---------- */

// 件数が少ないうちは全件読んで画面側で絞り込む(PDF本体は含まないので軽い)
async function fetchCaseItems() {
  const snapshot = await db.collection(CASE_ITEM_COLLECTION).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function fetchCaseItemsByGroup(groupKey) {
  const all = await fetchCaseItems();
  return all.filter((d) => customerGroupOf(d.customer) === groupKey);
}

// 品番(案件)ごとにまとめる。戻り値は受注日の新しい順
function groupCaseItemsByCode(items) {
  const map = new Map();
  items.forEach((d) => {
    const key = d.productCode || "(品番なし)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  });
  return Array.from(map.entries())
    .map(([code, rows]) => summarizeCaseRows(code, rows))
    .sort((a, b) => String(b.lastOrderDate).localeCompare(String(a.lastOrderDate)) || a.code.localeCompare(b.code));
}

// 案件の合計。外注金額は「外注単価×受注数量」で数える(1個あたりの差を見るため)
function summarizeCaseRows(code, rows) {
  const sum = (fn) => rows.reduce((t, d) => t + (fn(d) || 0), 0);
  const orderTotal = sum((d) => d.orderUnitPrice * d.qty);
  const outsourceTotal = sum((d) => d.outsourceUnitPrice * d.qty);
  const dates = rows.map((d) => d.orderDate).filter(Boolean).sort();
  return {
    code,
    rows,
    customer: rows[0] ? rows[0].customer : "",
    count: rows.length,
    orderTotal,
    outsourceTotal,
    firstOrderDate: dates[0] || "",
    lastOrderDate: dates[dates.length - 1] || "",
    outsourcers: Array.from(new Set(rows.flatMap((d) =>
      caseCostLines(d).length ? costVendors(caseCostLines(d)) : [d.outsourcer]).filter(Boolean))),
    needsCheckCount: rows.filter((d) => d.needsCheck).length,
  };
}

function loadCaseDocBlob(docId) {
  return readFileChunks(db.collection(CASE_DOC_COLLECTION).doc(docId), "application/pdf");
}

/* ---------- 更新(突き合わせ表の「修正」) ---------- */

async function updateCaseItem(id, fields) {
  await db.collection(CASE_ITEM_COLLECTION).doc(id).update({
    ...fields,
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

/* ---------- 取り込み ---------- */

// 取り込み用ファイル(JSON)の形式チェック。問題があればErrorを投げる
function validateCaseBundle(bundle) {
  if (!bundle || bundle.format !== CASE_IMPORT_FORMAT) {
    throw new Error("このファイルは取り込み用ファイルではありません。");
  }
  if (!bundle.customer || !Array.isArray(bundle.items) || bundle.items.length === 0) {
    throw new Error("取り込み用ファイルに客先名または明細がありません。");
  }
  bundle.items.forEach((it, i) => {
    if (!it.productCode || !it.drawingNo) {
      throw new Error(`${i + 1}行目に品番または図面番号がありません。`);
    }
  });
  return bundle;
}

function base64ToFile(base64, fileName) {
  const blob = base64ToBlob(base64, "application/pdf");
  return new File([blob], fileName, { type: "application/pdf" });
}

/**
 * 取り込む各明細を、どのドキュメントIDに書くか決める。
 * 同じ案件(客先グループ＋品番)に同じ図面番号の行がすでにあれば、その行を上書きする
 * (伝票番号が同じもの → 伝票番号が空の手入力の行 の順に探す)。
 * これで、進行中に手入力していた案件をあとでまとめて取り込んでも行が二重にならない。
 * 戻り値: { ids: [明細ごとのID], existing: Set(上書きになる明細の番号) }
 */
async function resolveImportTargets(bundle, items) {
  const group = customerGroupOf(bundle.customer);
  const all = await fetchCaseItems();
  const byKey = new Map();
  all.forEach((d) => {
    const key = `${customerGroupOf(d.customer)}|${d.productCode}|${d.drawingNo}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  });
  const used = new Set();
  const ids = [];
  const existing = new Set();
  items.forEach((it, i) => {
    const candidates = (byKey.get(`${group}|${it.productCode}|${it.drawingNo}`) || []).filter((d) => !used.has(d.id));
    const hit = candidates.find((d) => (d.orderSlipNo || "") === (it.orderSlipNo || "")) ||
      candidates.find((d) => !d.orderSlipNo);
    if (hit) {
      used.add(hit.id);
      existing.add(i);
      ids.push(hit.id);
    } else {
      ids.push(caseItemId(bundle.customer, it));
    }
  });
  return { ids, existing };
}

// すでに登録済みで上書きになる明細の番号(画面で知らせるため)
async function findExistingCaseItemIds(bundle) {
  return (await resolveImportTargets(bundle, bundle.items)).existing;
}

/* ---------- 手入力の行(進行中の案件) ---------- */

// 新しい行を足す。同じ案件に同じ図面番号の行があればエラー
async function addCaseItemManual(item) {
  const id = caseItemId(item.customer, { ...item, orderSlipNo: item.orderSlipNo || "" });
  const all = await fetchCaseItems();
  const group = customerGroupOf(item.customer);
  if (all.some((d) => customerGroupOf(d.customer) === group && d.productCode === item.productCode && d.drawingNo === item.drawingNo)) {
    throw new Error(`図面番号「${item.drawingNo}」の行はすでにあります。その行の「修正」から直してください。`);
  }
  const data = {
    ...item,
    costs: caseCostLines(item),
    drawingId: item.drawingId || "",
    docId: "",
    sourceFile: "",
    manual: true,
    createdBy: auth.currentUser ? auth.currentUser.email : "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection(CASE_ITEM_COLLECTION).doc(id).set(data);
  return { id, ...data };
}

// 行を消す(図面や書類は消さない)
async function deleteCaseItem(id) {
  await db.collection(CASE_ITEM_COLLECTION).doc(id).delete();
}

/**
 * 取り込み用ファイルの内容をFirestoreに保存する。
 * items は画面で確認・修正したあとの明細(drawing.base64を含む)。
 * onProgress(done, total, label)
 *
 * 図面→明細の順に書く。明細が先にできて図面が無い、という状態を作らないため。
 */
async function saveCaseImport(bundle, items, onProgress) {
  const customer = bundle.customer;
  const user = auth.currentUser ? auth.currentUser.email : "";
  const total = items.length + (bundle.document ? 1 : 0);
  let done = 0;
  const step = (label) => onProgress && onProgress(++done, total, label);
  const { ids: targetIds } = await resolveImportTargets(bundle, items);

  // 元の注文書・御見積書
  let docId = "";
  if (bundle.document && bundle.document.base64) {
    docId = caseDocId(customer, bundle.sourceFile);
    const docRef = db.collection(CASE_DOC_COLLECTION).doc(docId);
    await deleteFileChunks(docRef);
    const file = base64ToFile(bundle.document.base64, bundle.document.fileName);
    const chunkCount = await writeFileChunks(docRef, file);
    await docRef.set({
      customer,
      title: bundle.document.title || "",
      fileName: bundle.document.fileName,
      fileSize: file.size,
      sourceFile: bundle.sourceFile || "",
      chunkCount,
      createdBy: user,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    step("注文書・御見積書");
  }

  for (let n = 0; n < items.length; n++) {
    // 図面(1枚ずつのPDF)。過去の図面の検索画面にも出るよう pdfDrawings に入れる
    let it = { ...items[n] }; // 画面側の明細を書き換えないよう写しを使う
    const drawingId = caseDrawingId(customer, it);
    if (it.drawing && it.drawing.base64) {
      const dRef = db.collection(PDF_COLLECTION).doc(drawingId);
      await deleteFileChunks(dRef);
      const file = base64ToFile(it.drawing.base64, it.drawing.fileName);
      const chunkCount = await writeFileChunks(dRef, file);
      await dRef.set({
        customer,
        productName: it.productName,
        productCode: it.productCode,
        drawingNo: it.drawingNo,
        drawingDate: "",
        drawingYear: null,
        drawingMonth: null,
        location: "",
        materials: [],
        size: "",
        category: "",
        fileName: file.name,
        fileSize: file.size,
        mimeType: "application/pdf",
        chunkCount,
        source: "caseImport",
        createdBy: user,
        createdAtText: new Date().toLocaleString("ja-JP"),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }

    // 外注の内訳がある場合は、外注単価=内訳の合計、外注先=内訳の全社 にそろえる
    const costs = caseCostLines(it).map((c) => ({
      vendor: c.vendor || "",
      process: c.process || "",
      unitPrice: c.unitPrice === "" || c.unitPrice === null || c.unitPrice === undefined ? null : Number(c.unitPrice),
      qty: Number(c.qty) || 0,
      quoteNo: c.quoteNo || "",
      ref: c.ref || "",
      kind: c.kind || "",
    }));
    if (costs.length) {
      it.outsourceUnitPrice = sumCostLines(costs);
      it.outsourcer = costVendors(costs).join("、");
    }

    await db.collection(CASE_ITEM_COLLECTION).doc(targetIds[n]).set({
      customer,
      costs,
      productCode: it.productCode,
      productName: it.productName || "",
      drawingNo: it.drawingNo,
      material: it.material || "",
      qty: Number(it.qty) || 0,
      orderUnitPrice: it.orderUnitPrice === "" ? null : Number(it.orderUnitPrice),
      orderSlipNo: it.orderSlipNo || "",
      orderDate: it.orderDate || "",
      outsourceUnitPrice: it.outsourceUnitPrice === "" ? null : Number(it.outsourceUnitPrice),
      outsourceQty: Number(it.outsourceQty) || 0,
      outsourcer: it.outsourcer || "",
      quoteNo: it.quoteNo || "",
      quoteDate: it.quoteDate || "",
      needsCheck: !!it.needsCheck,
      note: it.note || "",
      drawingId: it.drawing ? drawingId : "",
      drawingPage: it.drawing ? it.drawing.page : null,
      docId,
      sourceFile: bundle.sourceFile || "",
      createdBy: user,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    step(`${it.productCode} ${it.drawingNo}`);
  }
}

/* ==========================================================
   PDF表示モーダル(突き合わせ表・取り込み画面で共用)
   ========================================================== */

let caseViewerUrl = null;
let caseViewerToken = 0;

function ensureCaseViewer() {
  if (document.getElementById("caseViewerModal")) return;
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "caseViewerModal";
  el.innerHTML = `
    <div class="modal-box modal-box-wide">
      <div class="modal-head">
        <h3 id="caseViewerTitle">図面</h3>
        <button class="modal-close" type="button" id="caseViewerClose">&times;</button>
      </div>
      <div class="modal-body modal-body-flush">
        <div id="caseViewerMeta" class="viewer-meta"></div>
        <div id="caseViewerFrame" class="viewer-frame-area"></div>
      </div>
      <div class="modal-foot">
        <span></span>
        <span>
          <a id="caseViewerTab" class="btn btn-secondary" target="_blank" rel="noopener">別タブで開く</a>
          <a id="caseViewerDownload" class="btn btn-primary" download>ダウンロード</a>
        </span>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (ev) => {
    if (ev.target === el) closeCaseViewer();
  });
  document.getElementById("caseViewerClose").addEventListener("click", closeCaseViewer);
}

/**
 * PDFをモーダルで表示する。
 * opts: { title, metaHtml, fileName, loadBlob: () => Promise<Blob> }
 */
async function openCaseViewer(opts) {
  ensureCaseViewer();
  const token = ++caseViewerToken;
  releaseCaseViewerUrl();
  document.getElementById("caseViewerTitle").textContent = opts.title || "図面";
  document.getElementById("caseViewerMeta").innerHTML = opts.metaHtml || "";
  document.getElementById("caseViewerFrame").innerHTML = `<div class="empty-state">PDFを読み込んでいます…</div>`;
  const tab = document.getElementById("caseViewerTab");
  const dl = document.getElementById("caseViewerDownload");
  tab.removeAttribute("href");
  dl.removeAttribute("href");
  document.getElementById("caseViewerModal").classList.add("open");

  try {
    const blob = await opts.loadBlob();
    if (token !== caseViewerToken) return; // 読み込み中に別のPDFへ切り替わった
    caseViewerUrl = URL.createObjectURL(blob);
    const frame = document.getElementById("caseViewerFrame");
    // Outlookのメール(.msg/.eml)は、件名・本文・添付を読み取って表示する(order-store.js)
    if (typeof isMailFile === "function" && isMailFile(opts.fileName)) {
      frame.innerHTML = `<div class="empty-state">メールを読み込んでいます…</div>`;
      await renderMailInto(frame, blob, opts.fileName);
      tab.style.display = "none";
    } else {
      frame.innerHTML = `<iframe src="${caseViewerUrl}" title="${escapeHtml(opts.title || "図面")}"></iframe>`;
      tab.style.display = "";
    }
    tab.href = caseViewerUrl;
    dl.href = caseViewerUrl;
    dl.setAttribute("download", opts.fileName || "drawing.pdf");
  } catch (err) {
    console.error("PDFの読み込みに失敗しました", err);
    if (token !== caseViewerToken) return;
    document.getElementById("caseViewerFrame").innerHTML =
      `<div class="empty-state">PDFを読み込めませんでした。<br>${escapeHtml(err.message || err)}</div>`;
  }
}

function releaseCaseViewerUrl() {
  if (caseViewerUrl) {
    URL.revokeObjectURL(caseViewerUrl);
    caseViewerUrl = null;
  }
}

function closeCaseViewer() {
  caseViewerToken++;
  const modal = document.getElementById("caseViewerModal");
  if (modal) modal.classList.remove("open");
  const frame = document.getElementById("caseViewerFrame");
  if (frame) frame.innerHTML = "";
  releaseCaseViewerUrl();
}
