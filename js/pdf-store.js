/* ==========================================================
   未来栄株式会社 図面管理システム  PDF図面の保存・読み出し
   ----------------------------------------------------------
   Firebase Storage(有料プラン必須)を使わず、無料のSparkプランのまま
   運用できるよう、PDFをBase64化してFirestoreに「分割保存」する。

     pdfDrawings/{id}              … 客先・図面作成日・品名などの検索用データ
     pdfDrawings/{id}/chunks/{nnnn}… PDF本体を分割したBase64文字列

   Firestoreは1ドキュメント約1MBが上限のため、1チャンク50万文字
   (=約0.5MB)ずつに分けて書き込む。読み出し時に結合して元に戻す。
   ========================================================== */

const PDF_COLLECTION = "pdfDrawings";

// 1チャンクあたりのBase64文字数。Firestoreの1MB上限に対して十分な余裕をとる。
const PDF_CHUNK_SIZE = 500000;

// 1ファイルあたりの上限。Base64化で約1.34倍に膨らむ点と、
// Firestore無料枠(合計1GB)を踏まえた実用上の上限。
const PDF_MAX_FILE_SIZE = 20 * 1024 * 1024;

// 客先一覧CSVの既定の置き場所と、画面から読み込んだ一覧の保存先
const CUSTOMER_CSV_PATH = "data/customers.csv";
const CUSTOMER_STORAGE_KEY = "miraiei_customer_list";

// 品名一覧CSV(入力補完の候補)の既定の置き場所。
// 客先と違い、品名は「一覧にない候補を自由入力する」ことが前提のため、
// こちらはアップロードでの差し替えは用意せず、data/products.csvの内容をそのまま使う。
const PRODUCT_CSV_PATH = "data/products.csv";

/* ---------- 汎用ヘルパー ---------- */

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// 「2026-09-24」→「2026年9月24日」
function formatDrawingDate(isoDate) {
  if (!isoDate) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 指定した年月の日数(うるう年対応)
function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

/* ---------- Base64変換 ---------- */

// ArrayBuffer → Base64文字列。
// String.fromCharCodeは引数が多すぎると落ちるため、3万2千バイトずつ処理する。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const STEP = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "application/pdf" });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("ファイルの読み込みに失敗しました"));
    reader.readAsArrayBuffer(file);
  });
}

/* ---------- 保存 ---------- */

/**
 * PDFを1件保存する。
 * meta: { customer, drawingDate:"YYYY-MM-DD", productName }
 * onProgress(done, total) … チャンクの書き込み進捗(0〜total)
 *
 * 本体チャンクを先に書き、最後に検索用ドキュメントを書く。
 * こうすることで、途中で失敗した中途半端な図面が一覧に出てこない。
 */
async function savePdfDrawing(file, meta, onProgress) {
  if (file.size > PDF_MAX_FILE_SIZE) {
    throw new Error(
      `ファイルサイズが大きすぎます(${formatFileSize(file.size)})。1ファイル${formatFileSize(PDF_MAX_FILE_SIZE)}までです。`
    );
  }

  const buffer = await readFileAsArrayBuffer(file);
  const base64 = arrayBufferToBase64(buffer);
  const chunkCount = Math.ceil(base64.length / PDF_CHUNK_SIZE);

  const docRef = db.collection(PDF_COLLECTION).doc();
  const chunksRef = docRef.collection("chunks");

  if (onProgress) onProgress(0, chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const part = base64.substr(i * PDF_CHUNK_SIZE, PDF_CHUNK_SIZE);
    await chunksRef.doc(String(i).padStart(4, "0")).set({ i, data: part });
    if (onProgress) onProgress(i + 1, chunkCount);
  }

  const now = new Date();
  const [year, month, day] = meta.drawingDate.split("-");

  await docRef.set({
    customer: meta.customer,
    productName: meta.productName,
    drawingDate: meta.drawingDate,
    // 年・月での絞り込みを軽くするために分解した値も持たせておく
    drawingYear: Number(year),
    drawingMonth: Number(month),
    drawingDay: Number(day),
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || "application/pdf",
    chunkCount,
    createdBy: auth.currentUser ? auth.currentUser.email : "",
    createdAtText: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  return docRef.id;
}

/* ---------- 読み出し ---------- */

// 検索用の一覧(PDF本体は含まないので軽い)
async function fetchPdfDrawings() {
  try {
    const snapshot = await db.collection(PDF_COLLECTION).orderBy("drawingDate", "desc").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error("保存済み図面の取得に失敗しました", err);
    throw err;
  }
}

async function fetchPdfDrawing(id) {
  const doc = await db.collection(PDF_COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// 分割保存されたチャンクを集めてPDFのBlobに戻す
async function loadPdfBlob(id, mimeType) {
  const snapshot = await db.collection(PDF_COLLECTION).doc(id).collection("chunks").get();
  if (snapshot.empty) {
    throw new Error("PDF本体のデータが見つかりませんでした。");
  }
  const parts = snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => a.i - b.i)
    .map((c) => c.data);
  return base64ToBlob(parts.join(""), mimeType);
}

/* ---------- 削除 ---------- */

// 先に検索用ドキュメントを消し、そのあと本体チャンクを消す。
// (逆順だと、消し終わる前に一覧から開かれて中身が空になることがある)
async function deletePdfDrawing(id) {
  const docRef = db.collection(PDF_COLLECTION).doc(id);
  await docRef.delete();

  const snapshot = await docRef.collection("chunks").get();
  for (const chunk of snapshot.docs) {
    await chunk.ref.delete();
  }
}

/* ==========================================================
   客先一覧CSVの読み込み
   ========================================================== */

// Excelが保存したCSVはShift_JISのことが多いので、UTF-8で読めなければ
// Shift_JISとして読み直す。BOM付きUTF-8にも対応する。
function decodeCsvBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

// ダブルクォート囲み・改行入りセルに対応した簡易CSVパーサ
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // CRLFのCRは読み飛ばす
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// CSVの表から名称の列を取り出す汎用関数(客先一覧・品名一覧の両方で使う)。
// 1行目にheaderPatternへ一致する見出しがあればその列を使い、無ければ1列目を使う。
function extractNamesFromCsvRows(rows, headerPattern) {
  if (rows.length === 0) return [];

  const header = rows[0].map((c) => c.trim());
  let columnIndex = 0;
  let startRow = 0;

  const hit = header.findIndex((c) => headerPattern.test(c));
  if (hit >= 0) {
    columnIndex = hit;
    startRow = 1;
  }

  const names = [];
  const seen = new Set();
  for (let r = startRow; r < rows.length; r++) {
    const name = (rows[r][columnIndex] || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

const CUSTOMER_HEADER_PATTERN = /客先|取引先|得意先|顧客|会社名|会社|customer|company|name/i;
const PRODUCT_HEADER_PATTERN = /品名|部品名|製品名|product|name/i;

function parseCustomerCsvBuffer(buffer) {
  return extractNamesFromCsvRows(parseCsv(decodeCsvBuffer(buffer)), CUSTOMER_HEADER_PATTERN);
}

function parseProductCsvBuffer(buffer) {
  return extractNamesFromCsvRows(parseCsv(decodeCsvBuffer(buffer)), PRODUCT_HEADER_PATTERN);
}

/* ---------- 客先一覧の取得と保存 ---------- */

function getStoredCustomerList() {
  try {
    const raw = localStorage.getItem(CUSTOMER_STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch (err) {
    return null;
  }
}

function storeCustomerList(list) {
  try {
    localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("客先一覧をブラウザに保存できませんでした", err);
  }
}

function clearStoredCustomerList() {
  try {
    localStorage.removeItem(CUSTOMER_STORAGE_KEY);
  } catch (err) {
    /* 何もしない */
  }
}

/**
 * 客先一覧を取得する。
 * 1. 画面からCSVを読み込み済みなら、それ(ブラウザに保存されている)を使う
 * 2. 無ければリポジトリ内の data/customers.csv を読む
 * 戻り値: { list, source: "uploaded"|"file"|"none" }
 */
async function loadCustomerList() {
  const stored = getStoredCustomerList();
  if (stored) return { list: stored, source: "uploaded" };

  try {
    const res = await fetch(CUSTOMER_CSV_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = parseCustomerCsvBuffer(await res.arrayBuffer());
    return { list, source: list.length > 0 ? "file" : "none" };
  } catch (err) {
    // ローカルファイル(file://)で開いた場合はfetchがブロックされるためここに来る
    console.warn("客先一覧CSVを読み込めませんでした", err);
    return { list: [], source: "none" };
  }
}

/**
 * 品名の入力補完に使う候補一覧を取得する(data/products.csvを読む)。
 * 客先と違い「一覧にない品名の自由入力」が前提のため、見つからなければ
 * 空配列を返すだけでよい(入力欄はそのまま自由記入として機能する)。
 */
async function loadProductNameList() {
  try {
    const res = await fetch(PRODUCT_CSV_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return parseProductCsvBuffer(await res.arrayBuffer());
  } catch (err) {
    console.warn("品名一覧CSVを読み込めませんでした", err);
    return [];
  }
}
