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

async function deleteOrder(id) {
  await db.collection(ORDER_COLLECTION).doc(id).delete();
}
