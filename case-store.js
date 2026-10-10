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
   「過去の図面をさがす」で最初に選ぶ4つ。aliasesは表記ゆれの吸収用。
   どれにも当てはまらない客先は「その他」に入る。 */
const CASE_CUSTOMER_GROUPS = [
  { key: "CAM'S", label: "CAM'S", aliases: ["CAM'S", "CAMS", "キャムズ"] },
  { key: "神栄", label: "神栄", aliases: ["神栄"] },
  { key: "DID", label: "DID", aliases: ["DID"] },
  { key: "その他", label: "その他", aliases: [] },
];
const CASE_OTHER_GROUP = "その他";

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
    outsourcers: Array.from(new Set(rows.map((d) => d.outsourcer).filter(Boolean))),
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

// すでに登録済みの明細のID(上書きになるものを画面で知らせるため)
async function findExistingCaseItemIds(bundle) {
  const ids = bundle.items.map((it) => caseItemId(bundle.customer, it));
  const existing = new Set();
  for (const id of ids) {
    const doc = await db.collection(CASE_ITEM_COLLECTION).doc(id).get();
    if (doc.exists) existing.add(id);
  }
  return existing;
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

  for (const it of items) {
    // 図面(1枚ずつのPDF)。過去の図面の検索画面にも出るよう pdfDrawings に入れる
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

    await db.collection(CASE_ITEM_COLLECTION).doc(caseItemId(customer, it)).set({
      customer,
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
    document.getElementById("caseViewerFrame").innerHTML =
      `<iframe src="${caseViewerUrl}" title="${escapeHtml(opts.title || "図面")}"></iframe>`;
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
