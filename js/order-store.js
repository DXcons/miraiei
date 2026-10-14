/* ==========================================================
   未来栄株式会社 図面管理システム  受発注・請求書の管理
   ----------------------------------------------------------
   取引1件 = Firestore orders コレクションの1ドキュメント。

     orders/{id} … dueDate("2026-12-12" / 未定なら"")、branch、customer、
                   productName(品名)、amount(金額・税抜の数値 / 未入力ならnull)、
                   quoteNo(見積番号)、invoiceDate(請求日 "2026-12-20" / 未入力なら"")、
                   status、note、作成・更新の記録
   ========================================================== */

const ORDER_COLLECTION = "orders";

const ORDER_BRANCHES = ["福井", "東京"];

// ステータスの並び順。「次へ」ボタンはこの順に進める。
// 「受注せず」は流れの外にある終了状態なので、次へは進めない。
const ORDER_STATUSES = [
  { value: "商談中", cls: "st-talk" },
  { value: "見積もり中", cls: "st-quote" },
  { value: "製作中", cls: "st-make" },
  { value: "納品済み", cls: "st-delivered" },
  // 請求書をつくったら完了(過去の案件でも検索できるようになる)
  { value: "請求済み", cls: "st-billed", closed: true },
  { value: "入金済み", cls: "st-paid", closed: true },
  { value: "受注せず", cls: "st-lost", closed: true },
];

const ORDER_FLOW = ORDER_STATUSES.filter((s) => s.value !== "受注せず").map((s) => s.value);

function orderStatusInfo(value) {
  return ORDER_STATUSES.find((s) => s.value === value) || ORDER_STATUSES[0];
}

// 次のステータス(無ければnull)
function nextOrderStatus(value) {
  const i = ORDER_FLOW.indexOf(value);
  return i >= 0 && i < ORDER_FLOW.length - 1 ? ORDER_FLOW[i + 1] : null;
}

// 請求済み・入金済み・受注せずは「終わった取引」
function isOrderClosed(value) {
  return !!orderStatusInfo(value).closed;
}

// 納品前のステータス(納期遅れの警告を出す対象)
function isBeforeDelivery(value) {
  return ["商談中", "見積もり中", "製作中"].includes(value);
}

// 「出荷待ち」= 納品前(商談中・見積もり中・製作中)
// 「出荷済み」= 出荷完了を押した案件(納品済み)と、その後に請求書をつくった案件(請求済み・入金済み)。
// 出荷済みの案件は出荷した月のフォルダに残る。
function isShipPending(value) {
  return isBeforeDelivery(value);
}

function isShipped(value) {
  return value === "納品済み" || value === "請求済み" || value === "入金済み";
}

/* ---------- 次の納期 ----------
   dueDate は客先に収める「最終の納期」。nextDueDate は、他社への二次依頼の納期など
   途中のステップの納期で、社長らが手で入れる。二次依頼がない案件は nextDueNone を立てる。
   出荷待ちの表では、どちらも入っていない案件(=入力待ち)を赤で目立たせて上に並べる。 */
function needsNextDue(order) {
  return !order.nextDueDate && !order.nextDueNone;
}

// "2026-12-12" → "2026/12/12"、空なら「未定」
function formatDueDate(value) {
  return value ? value.replace(/-/g, "/") : "未定";
}

// 請求日など、空欄なら「—」と出す日付
function formatOrderDate(value) {
  return value ? value.replace(/-/g, "/") : "—";
}

// 1234000 → "¥1,234,000"、未入力なら「—」
function formatAmount(value) {
  return typeof value === "number" ? "¥" + value.toLocaleString("ja-JP") : "—";
}

// 入力欄の文字 → 金額(数値)。「1,234,000」「１２３４」「¥5000」も受け付ける。
// 空欄はnull、数字として読めなければNaNを返す。
function parseAmount(text) {
  const cleaned = String(text || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[,，¥￥円\s]/g, "");
  if (!cleaned) return null;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : NaN;
}

/* ---------- 受注日(月ごとのフォルダ分けに使う) ----------
   orderDate("2026-10-10")を持つ。以前に登録した取引で受注日が無いものは、
   登録した日(createdAt)を代わりに使う。どちらも無ければ""。 */
function orderReceivedDate(order) {
  if (order.orderDate) return order.orderDate;
  const ts = order.createdAt;
  if (ts && typeof ts.toDate === "function") {
    const d = ts.toDate();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return "";
}

// "2026-10-10" → { year: 2026, month: 10 }。日付が無ければnull
function orderYearMonth(order) {
  const m = /^(\d{4})-(\d{2})/.exec(orderReceivedDate(order));
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/* ---------- 受注№(注文書・納品書に印字する社内の番号) ----------
   「MDA＋受注日の年2桁＋月2桁＋その月の連番3桁」。例 MDA2607023 */
function nextOrderNo(orders, dateText) {
  const d = /^(\d{4})-(\d{2})/.exec(dateText || "") || /^(\d{4})-(\d{2})/.exec(new Date().toISOString());
  const prefix = `MDA${d[1].slice(2)}${d[2]}`;
  const used = orders
    .map((o) => String(o.orderNo || ""))
    .filter((no) => no.startsWith(prefix))
    .map((no) => Number(no.slice(prefix.length)) || 0);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return prefix + String(next).padStart(3, "0");
}

/* ---------- 読み書き ---------- */

async function fetchOrders() {
  const snapshot = await db.collection(ORDER_COLLECTION).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function orderAuditFields() {
  const now = new Date();
  return {
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAtText: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
}

// fields: { dueDate, branch, customer, productName, amount, quoteNo, invoiceDate, status, note }
async function addOrder(fields) {
  const data = Object.assign({}, fields, orderAuditFields(), {
    createdBy: auth.currentUser ? auth.currentUser.email : "",
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  const ref = await db.collection(ORDER_COLLECTION).add(data);
  return ref.id;
}

async function updateOrder(id, fields) {
  const data = Object.assign({}, fields, orderAuditFields());
  await db.collection(ORDER_COLLECTION).doc(id).update(data);
  return data;
}

// 取引を消すときは、その取引に保存した書類も一緒に消す
// (紐づけた図面は「図面をさがす」側のデータなので消さない)
async function deleteOrder(id) {
  await db.collection(ORDER_COLLECTION).doc(id).delete();
  const files = await db.collection(ORDER_FILE_COLLECTION).where("orderId", "==", id).get();
  for (const doc of files.docs) {
    await deleteOrderFile(doc.id);
  }
}

/* ==========================================================
   取引の書類(見積書・納品書・請求書・写真など)
   ----------------------------------------------------------
   図面と同じく、Firestoreへ分割保存する(pdf-store.js の writeFileChunks)。
     orderFiles/{id}               … orderId・書類の種類・ファイル名など
     orderFiles/{id}/chunks/{nnnn} … ファイル本体
   図面は保存済みの図面(pdfDrawings)を orders/{id}.drawingIds で紐づけるだけで、
   ここには保存しない。
   ========================================================== */

const ORDER_FILE_COLLECTION = "orderFiles";

// アップロードするときに選ぶ書類の種類
const ORDER_UPLOAD_TYPES = ["客先からの注文書", "注文メール", "図面", "外注先からの見積もり", "外注先からの検査書", "その他"];
// 表示するときの種類(表示順)。以前の種類で保存した書類もまとめて出せるよう、昔の種類も残している。
const ORDER_DOC_TYPES = [
  ...ORDER_UPLOAD_TYPES.filter((t) => t !== "その他"),
  "外注先への注文書", "納品書", "請求書", "写真", "その他",
];
// 以前の呼び方 → いまの呼び方
const ORDER_DOC_TYPE_ALIASES = { "客先の注文書": "客先からの注文書", "見積書": "外注先からの見積もり" };

function orderDocType(file) {
  const t = ORDER_DOC_TYPE_ALIASES[file.docType] || file.docType;
  return ORDER_DOC_TYPES.includes(t) ? t : "その他";
}

/* ---------- 案件との対応 ----------
   取引(orders)は caseCode(品番。DIDは注文番号)を持ち、客先グループ＋品番で
   「過去の図面をさがす」の案件ページ(case-detail.html)と対応する。
   案件ページで追加した書類は orderFiles.orderId に「案件キー」を入れて保存するので、
   取引を登録する前でも書類を貯めておける。 */
function caseKeyOf(groupKey, code) {
  return `case__${groupKey}__${String(code || "").trim()}`;
}

function orderCaseKey(order) {
  return order && order.caseCode ? caseKeyOf(customerGroupOf(order.customer), order.caseCode) : null;
}

function caseDetailUrl(groupKey, code) {
  return `case-detail.html?customer=${encodeURIComponent(groupKey)}&code=${encodeURIComponent(code)}`;
}

// 案件(客先グループ＋品番)に対応する取引。無ければnull
function findCaseOrder(orders, groupKey, code) {
  return orders.find((o) => o.caseCode && String(o.caseCode).trim() === String(code).trim() &&
    customerGroupOf(o.customer) === groupKey) || null;
}

// 写真は長い辺をこの大きさまで縮め、JPEGにして容量を節約する
const IMAGE_MAX_EDGE = 2400;
const IMAGE_JPEG_QUALITY = 0.85;

// ブラウザの中で表示できる形式か(できないもの=Excelなどはダウンロードして開く)
function fileViewKind(mimeType, fileName) {
  if (mimeType === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  if (/^image\//.test(mimeType || "") || /\.(png|jpe?g|gif|webp)$/i.test(fileName)) return "image";
  return "download";
}

function fileIcon(mimeType, fileName) {
  const kind = fileViewKind(mimeType, fileName);
  if (kind === "pdf") return "📄";
  if (kind === "image") return "🖼️";
  if (/\.(xlsx?|xlsm|csv)$/i.test(fileName)) return "📊";
  if (/\.docx?$/i.test(fileName)) return "📝";
  return "📎";
}

// 写真(PNG/JPEGなど)を縮小・JPEG化する。小さくならなければ元のファイルを返す。
async function compressImageIfLarge(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const url = URL.createObjectURL(file);
  try {
    const bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像を読み込めませんでした"));
      img.src = url;
    });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.naturalWidth, bitmap.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.naturalWidth * scale);
    canvas.height = Math.round(bitmap.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // 透過PNGの透明部分が黒くならないよう白で塗っておく
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_JPEG_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch (err) {
    console.warn("画像を縮小できませんでした。元のまま保存します。", err);
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 書類の一覧(本体は含まないので軽い)。全取引分をまとめて取る。
async function fetchOrderFiles() {
  const snapshot = await db.collection(ORDER_FILE_COLLECTION).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * 書類を1件保存する。本体チャンクを先に書き、最後に一覧用ドキュメントを書く
 * (途中で失敗した中途半端な書類が一覧に出ないように)。
 */
async function saveOrderFile(orderId, docType, file, onProgress) {
  if (file.size > PDF_MAX_FILE_SIZE) {
    throw new Error(
      `ファイルサイズが大きすぎます(${formatFileSize(file.size)})。1ファイル${formatFileSize(PDF_MAX_FILE_SIZE)}までです。`
    );
  }
  const stored = await compressImageIfLarge(file);
  const docRef = db.collection(ORDER_FILE_COLLECTION).doc();
  const chunkCount = await writeFileChunks(docRef, stored, onProgress);
  const now = new Date();
  const data = {
    orderId,
    docType,
    fileName: stored.name,
    fileSize: stored.size,
    originalSize: file.size,
    mimeType: stored.type || "application/octet-stream",
    chunkCount,
    createdBy: auth.currentUser ? auth.currentUser.email : "",
    createdAtText: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  await docRef.set(data);
  return { id: docRef.id, ...data };
}

async function loadOrderFileBlob(id, mimeType) {
  return readFileChunks(db.collection(ORDER_FILE_COLLECTION).doc(id), mimeType);
}

async function deleteOrderFile(id) {
  const docRef = db.collection(ORDER_FILE_COLLECTION).doc(id);
  await docRef.delete();
  await deleteFileChunks(docRef);
}

// 保存済み図面の紐づけ・解除(orders/{id}.drawingIds に図面のIDを持たせる)
async function linkOrderDrawings(orderId, drawingIds) {
  await db.collection(ORDER_COLLECTION).doc(orderId).update({
    drawingIds: firebase.firestore.FieldValue.arrayUnion(...drawingIds),
  });
}

async function unlinkOrderDrawing(orderId, drawingId) {
  await db.collection(ORDER_COLLECTION).doc(orderId).update({
    drawingIds: firebase.firestore.FieldValue.arrayRemove(drawingId),
  });
}
