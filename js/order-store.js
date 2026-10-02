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
  { value: "請求済み", cls: "st-billed" },
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

// 入金済み・受注せずは「終わった取引」
function isOrderClosed(value) {
  return !!orderStatusInfo(value).closed;
}

// 納品前のステータス(納期遅れの警告を出す対象)
function isBeforeDelivery(value) {
  return ["商談中", "見積もり中", "製作中"].includes(value);
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

// 書類の種類(表示順)。図面は「紐づけ」なのでアップロードの選択肢には出さない。
const ORDER_DOC_TYPES = ["見積書", "図面", "納品書", "請求書", "写真", "その他"];
const ORDER_UPLOAD_TYPES = ORDER_DOC_TYPES.filter((t) => t !== "図面");

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
