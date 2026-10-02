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

/* ---------- 任意で入力する分類項目 ----------
   「図面を保存する」画面の選択肢と「過去の図面をさがす」画面の絞り込みは
   この定義を共有する。項目を増やすときはここを直せば両画面に反映される。
   (common.jsの旧モック用ラベルと名前が衝突しないようPDF_接頭辞を付けている) */
const PDF_OPTION_FIELDS = [
  {
    key: "location",
    label: "設置場所",
    multiple: false,
    options: [
      { value: "outdoor", label: "屋外" },
      { value: "indoor", label: "屋内" },
    ],
  },
  {
    key: "materials",
    label: "材質",
    multiple: true,
    options: [
      { value: "resin", label: "樹脂" },
      { value: "metal", label: "金属" },
    ],
  },
  {
    key: "size",
    label: "大きさ",
    multiple: false,
    options: [
      { value: "large", label: "大物" },
      { value: "small", label: "小物" },
    ],
  },
  {
    key: "category",
    label: "種別",
    multiple: false,
    options: [
      { value: "belt", label: "ベルトコンベヤ" },
      { value: "other", label: "それ以外" },
    ],
  },
];

// 値(outdoorなど)から表示用ラベル(屋外)を引く
function pdfOptionLabel(fieldKey, value) {
  const field = PDF_OPTION_FIELDS.find((f) => f.key === fieldKey);
  if (!field) return value;
  const option = field.options.find((o) => o.value === value);
  return option ? option.label : value;
}

// 客先一覧の保存先。画面の「客先一覧の編集」で保存した一覧はFirestoreの
// settings/customers に入り、全員・全PCで共有される。
// まだ一度も編集していない間は data/customers.csv を初期値として使う。
const CUSTOMER_CSV_PATH = "data/customers.csv";
const SETTINGS_COLLECTION = "settings";
const CUSTOMER_DOC_ID = "customers";
// 以前の「客先一覧を差し替える」(CSV読み込み)でブラウザに保存していた一覧。
// Firestoreにまだ一覧が無いときだけ初期値として引き継ぐ。
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

// 図面作成日の表示。年月が不明な場合もあるので複数の形式を受け付ける。
//   "2026-09" → 「2026年9月」 / "2026" → 「2026年（月不明）」 / "" → 「不明」
//   "2026-09-24" は日まで入れていた頃に保存したデータ用
function formatDrawingDate(value) {
  if (!value) return "不明";
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) return `${Number(ymd[1])}年${Number(ymd[2])}月${Number(ymd[3])}日`;
  const ym = /^(\d{4})-(\d{2})$/.exec(value);
  if (ym) return `${Number(ym[1])}年${Number(ym[2])}月`;
  const y = /^(\d{4})$/.exec(value);
  if (y) return `${Number(y[1])}年（月不明）`;
  return value;
}

function pad2(n) {
  return String(n).padStart(2, "0");
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

/* ---------- 保存容量の目安 ----------
   Firestore無料枠の保存容量は1GiB。ファイルはBase64化して保存しているので
   実際の容量は元のファイルの約4/3倍になる。正確な値はFirebaseコンソールの
   「使用量」でしか分からないため、画面に出すのはファイルサイズからの概算。 */
const FREE_STORAGE_BYTES = 1024 * 1024 * 1024;

function storedBytesOf(fileSize) {
  return Math.ceil((fileSize || 0) * 4 / 3) + 1024; // 1KBは検索用データなどの分
}

// 図面と取引の書類を合計した使用量(概算)。{ used, limit, drawingBytes, fileBytes }
async function estimateStorageUsage() {
  const sum = (snapshot) =>
    snapshot.docs.reduce((total, doc) => total + storedBytesOf(doc.data().fileSize), 0);
  const drawingBytes = sum(await db.collection(PDF_COLLECTION).get());
  let fileBytes = 0;
  try {
    fileBytes = sum(await db.collection("orderFiles").get());
  } catch (err) {
    // 書類の許可がまだルールに無い場合は図面の分だけで計算する
    console.warn("書類の容量を取得できませんでした", err);
  }
  return { used: drawingBytes + fileBytes, limit: FREE_STORAGE_BYTES, drawingBytes, fileBytes };
}

// 容量メーターを指定した要素に描く
async function renderStorageMeter(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const { used, limit, drawingBytes, fileBytes } = await estimateStorageUsage();
    const pct = Math.min(100, (used / limit) * 100);
    const level = pct >= 90 ? "is-danger" : pct >= 70 ? "is-warn" : "";
    el.innerHTML = `
      <div class="storage-meter ${level}">
        <div class="storage-meter-head">
          <span>保存容量の使用状況（無料枠）</span>
          <b>約 ${formatFileSize(used)} ／ ${formatFileSize(limit)}（${pct < 1 && used > 0 ? "1%未満" : Math.round(pct) + "%"}）</b>
        </div>
        <div class="storage-bar"><div style="width:${Math.max(pct, used > 0 ? 0.5 : 0)}%"></div></div>
        <div class="storage-meter-note">
          内訳：図面 約${formatFileSize(drawingBytes)}・取引の書類 約${formatFileSize(fileBytes)}。
          ${pct >= 90 ? "残りがわずかです。不要なファイルの削除か、有料プランへの切り替えをご検討ください。"
            : pct >= 70 ? "7割を超えました。早めに管理者へご相談ください。"
            : "ファイルの大きさからの概算です。"}
        </div>
      </div>`;
  } catch (err) {
    console.warn("保存容量を計算できませんでした", err);
    el.innerHTML = "";
  }
}

/* ---------- 分割保存の共通処理(図面・取引の書類で共用) ---------- */

// ファイル本体をBase64化し、docRef/chunks/0000, 0001… に分けて書き込む。戻り値はチャンク数。
async function writeFileChunks(docRef, file, onProgress) {
  const buffer = await readFileAsArrayBuffer(file);
  const base64 = arrayBufferToBase64(buffer);
  const chunkCount = Math.max(1, Math.ceil(base64.length / PDF_CHUNK_SIZE));
  const chunksRef = docRef.collection("chunks");

  if (onProgress) onProgress(0, chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const part = base64.substr(i * PDF_CHUNK_SIZE, PDF_CHUNK_SIZE);
    await chunksRef.doc(String(i).padStart(4, "0")).set({ i, data: part });
    if (onProgress) onProgress(i + 1, chunkCount);
  }
  return chunkCount;
}

// 分割保存されたチャンクを集めて元のファイル(Blob)に戻す
async function readFileChunks(docRef, mimeType) {
  const snapshot = await docRef.collection("chunks").get();
  if (snapshot.empty) {
    throw new Error("ファイル本体のデータが見つかりませんでした。");
  }
  const parts = snapshot.docs
    .map((doc) => doc.data())
    .sort((a, b) => a.i - b.i)
    .map((c) => c.data);
  return base64ToBlob(parts.join(""), mimeType);
}

// 本体チャンクを消す(検索用ドキュメントは呼び出し側で先に消しておく)
async function deleteFileChunks(docRef) {
  const snapshot = await docRef.collection("chunks").get();
  for (const chunk of snapshot.docs) {
    await chunk.ref.delete();
  }
}

/* ---------- 保存 ---------- */

/**
 * PDFを1件保存する。
 * meta: { customer, drawingDate:"YYYY-MM", productName }
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

  const docRef = db.collection(PDF_COLLECTION).doc();
  const chunkCount = await writeFileChunks(docRef, file, onProgress);

  const now = new Date();
  // drawingDateは "2026-09"(年月) / "2026"(年のみ) / ""(不明) のいずれか
  const [year, month] = (meta.drawingDate || "").split("-");

  await docRef.set({
    customer: meta.customer,
    productName: meta.productName,
    drawingDate: meta.drawingDate || "",
    // 年・月での絞り込みを軽くするために分解した値も持たせておく(不明ならnull)
    drawingYear: year ? Number(year) : null,
    drawingMonth: month ? Number(month) : null,
    // 任意で入力する分類項目(未選択なら空)
    location: meta.location || "",
    materials: meta.materials || [],
    size: meta.size || "",
    category: meta.category || "",
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
  return readFileChunks(db.collection(PDF_COLLECTION).doc(id), mimeType);
}

/* ---------- 削除 ---------- */

// 先に検索用ドキュメントを消し、そのあと本体チャンクを消す。
// (逆順だと、消し終わる前に一覧から開かれて中身が空になることがある)
async function deletePdfDrawing(id) {
  const docRef = db.collection(PDF_COLLECTION).doc(id);
  await docRef.delete();
  await deleteFileChunks(docRef);
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

function parseCustomerCsvBuffer(buffer) {
  return extractNamesFromCsvRows(parseCsv(decodeCsvBuffer(buffer)), CUSTOMER_HEADER_PATTERN);
}

/* ==========================================================
   品名一覧CSVの読み込み(50音の行で絞り込むためのグループ分け)
   ========================================================== */

// data/products.csv は「品名,よみ」の2列。
// よみが空欄の行は「複数部品の図面」のように50音では分類しない
// 特別項目として扱い、候補パネルの先頭に常に表示する。
const PRODUCT_NAME_HEADER_PATTERN = /品名|部品名|製品名|product/i;
const PRODUCT_YOMI_HEADER_PATTERN = /よみ|読み|ふりがな|yomi|reading/i;

// 50音の行の並び順(候補パネルに表示する順番)
const KANA_ROW_ORDER = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ"];

// ひらがな1文字 → その行(濁音・半濁音・拗音・小書き文字は元になる行にまとめる)
const KANA_TO_ROW = {
  あ: "あ", い: "あ", う: "あ", え: "あ", お: "あ", ぁ: "あ", ぃ: "あ", ぅ: "あ", ぇ: "あ", ぉ: "あ",
  か: "か", き: "か", く: "か", け: "か", こ: "か", が: "か", ぎ: "か", ぐ: "か", げ: "か", ご: "か",
  さ: "さ", し: "さ", す: "さ", せ: "さ", そ: "さ", ざ: "さ", じ: "さ", ず: "さ", ぜ: "さ", ぞ: "さ",
  た: "た", ち: "た", つ: "た", て: "た", と: "た", だ: "た", ぢ: "た", づ: "た", で: "た", ど: "た", っ: "た",
  な: "な", に: "な", ぬ: "な", ね: "な", の: "な",
  は: "は", ひ: "は", ふ: "は", へ: "は", ほ: "は", ば: "は", び: "は", ぶ: "は", べ: "は", ぼ: "は",
  ぱ: "は", ぴ: "は", ぷ: "は", ぺ: "は", ぽ: "は",
  ま: "ま", み: "ま", む: "ま", め: "ま", も: "ま",
  や: "や", ゆ: "や", よ: "や", ゃ: "や", ゅ: "や", ょ: "や",
  ら: "ら", り: "ら", る: "ら", れ: "ら", ろ: "ら",
  わ: "わ", を: "わ", ん: "わ",
};

function kanaRowOf(char) {
  return KANA_TO_ROW[char] || null;
}

// 50音の行に振り分けられない品名(漢字・英字で始まるものなど)を入れるグループ
const PDF_OTHER_ROW_KEY = "他";

function katakanaToHiragana(text) {
  return String(text || "").replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// 品名そのものから50音の行を推測する(カナで始まる場合のみ判定できる)。
// よみを持たない、保存済み図面から拾ってきた品名の振り分けに使う。
function guessKanaRow(name) {
  const first = katakanaToHiragana(String(name || "").trim())[0];
  return first ? kanaRowOf(first) : null;
}

/**
 * 保存済み図面の品名を候補に加える。
 * これにより、一度「直接入力」で保存した品名は次回から候補に出るようになる。
 * カナで始まる品名はその行へ、判定できないもの(漢字始まりなど)は「その他」へ入れる。
 */
function mergeSavedProductNames(buckets, names) {
  const known = new Set(buckets.pinned);
  Object.keys(buckets.groups).forEach((row) => {
    buckets.groups[row].forEach((name) => known.add(name));
  });

  names.forEach((rawName) => {
    const name = String(rawName || "").trim();
    if (!name || known.has(name)) return;
    known.add(name);
    const row = guessKanaRow(name) || PDF_OTHER_ROW_KEY;
    if (!buckets.groups[row]) buckets.groups[row] = [];
    buckets.groups[row].push(name);
  });
  return buckets;
}

// 保存済み図面から品名だけを重複なく取り出す
async function fetchSavedProductNames() {
  try {
    const snapshot = await db.collection(PDF_COLLECTION).get();
    const names = snapshot.docs.map((doc) => doc.data().productName).filter(Boolean);
    return Array.from(new Set(names));
  } catch (err) {
    console.warn("保存済み図面の品名を取得できませんでした", err);
    return [];
  }
}

// data/products.csv が読み込めない環境(ローカルファイルとして開いた場合など)でも
// 候補が出るように、CSVと同じ初期内容をここにも持たせておく。
// 通常はCSV側が優先され、CSVを更新すればそちらが反映される。
const DEFAULT_PRODUCT_ITEMS = [
  { name: "複数部品の図面", yomi: "" },
  { name: "スタンド", yomi: "すたんど" },
  { name: "コモンプレート", yomi: "こもんぷれーと" },
  { name: "シリンダベース", yomi: "しりんだべーす" },
  { name: "シリンダブラケット", yomi: "しりんだぶらけっと" },
  { name: "ステー", yomi: "すてー" },
  { name: "スライダー", yomi: "すらいだー" },
  { name: "レール", yomi: "れーる" },
  { name: "受台スライダ", yomi: "うけだいすらいだ" },
  { name: "ハウジング", yomi: "はうじんぐ" },
  { name: "ガイド板", yomi: "がいどばん" },
  { name: "カットホルダ", yomi: "かっとほるだ" },
  { name: "切刃ホルダ", yomi: "せっぱほるだ" },
  { name: "刃ホルダ", yomi: "はほるだ" },
  { name: "軸受", yomi: "じくうけ" },
  { name: "軸受(上)", yomi: "じくうけうえ" },
  { name: "軸受(下)", yomi: "じくうけした" },
  { name: "ジョイント", yomi: "じょいんと" },
  { name: "反転アームステー", yomi: "はんてんあーむすてー" },
  { name: "反転ステー", yomi: "はんてんすてー" },
  { name: "テープ受皿", yomi: "てーぷうけざら" },
  { name: "テープ案内ガイド", yomi: "てーぷあんないがいど" },
  { name: "テープ受バー", yomi: "てーぷうけばー" },
  { name: "ガイドバー", yomi: "がいどばー" },
  { name: "クランプベース", yomi: "くらんぷべーす" },
  { name: "リール切出しスライダ", yomi: "りーるきりだしすらいだ" },
  { name: "ナット用ブラケット", yomi: "なっとようぶらけっと" },
  { name: "リールチャック昇降ベース", yomi: "りーるちゃっくしょうこうべーす" },
  { name: "切出しブラケット", yomi: "きりだしぶらけっと" },
  { name: "ストッパーブラケット", yomi: "すとっぱーぶらけっと" },
  { name: "ストッパーバー", yomi: "すとっぱーばー" },
  { name: "レバー", yomi: "ればー" },
  { name: "成形クランプバー", yomi: "せいけいくらんぷばー" },
];

// 客先一覧CSVが読み込めない場合の予備。data/customers.csv と同じ初期内容。
const DEFAULT_CUSTOMERS = ["TANIDA", "CAM'S", "茅原"];

// CSVの「品名,よみ」を { name, yomi } の配列に変換する
function parseProductCsvRows(buffer) {
  const rows = parseCsv(decodeCsvBuffer(buffer));
  if (rows.length === 0) return [];

  const header = rows[0].map((c) => c.trim());
  const nameHit = header.findIndex((c) => PRODUCT_NAME_HEADER_PATTERN.test(c));
  const yomiHit = header.findIndex((c) => PRODUCT_YOMI_HEADER_PATTERN.test(c));
  const hasHeader = nameHit >= 0 || yomiHit >= 0;
  const nameCol = nameHit >= 0 ? nameHit : 0;
  const yomiCol = yomiHit >= 0 ? yomiHit : 1;
  const startRow = hasHeader ? 1 : 0;

  const items = [];
  const seen = new Set();
  for (let r = startRow; r < rows.length; r++) {
    const name = (rows[r][nameCol] || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({ name, yomi: (rows[r][yomiCol] || "").trim() });
  }
  return items;
}

/**
 * 品名の候補一覧を取得し、「よみ」をもとに50音の行へ仕分けする。
 * よみが空欄の項目(「複数部品の図面」など)はpinnedへ、
 * それ以外はよみの1文字目でgroups["あ"]〜groups["わ"]へ分類する。
 * 戻り値: { pinned: string[], groups: { あ: string[], か: string[], ... } }
 */
async function loadProductBuckets() {
  const buckets = { pinned: [], groups: {} };
  KANA_ROW_ORDER.forEach((row) => (buckets.groups[row] = []));
  buckets.groups[PDF_OTHER_ROW_KEY] = [];

  let items = [];
  try {
    const res = await fetch(PRODUCT_CSV_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    items = parseProductCsvRows(await res.arrayBuffer());
  } catch (err) {
    // ローカルファイル(file://)で開いた場合はfetchがブロックされるためここに来る
    console.warn("品名一覧CSVを読み込めませんでした。内蔵の初期リストを使います。", err);
  }
  // CSVが読めない・中身が空のときは内蔵の初期リストで代用する
  if (items.length === 0) items = DEFAULT_PRODUCT_ITEMS;

  items.forEach(({ name, yomi }) => {
    if (!yomi) {
      buckets.pinned.push(name);
      return;
    }
    const row = kanaRowOf(yomi[0]) || "わ"; // 想定外の読み(記号など)はわ行にまとめる
    buckets.groups[row].push(name);
  });
  return buckets;
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

// 前後の空白を取り、空欄と重複を除いた一覧にする
function normalizeCustomerList(list) {
  const names = [];
  const seen = new Set();
  (list || []).forEach((raw) => {
    const name = String(raw == null ? "" : raw).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
}

// 画面で編集した客先一覧をFirestoreに保存する(全員で共有)
async function saveCustomerList(list) {
  const names = normalizeCustomerList(list);
  await db.collection(SETTINGS_COLLECTION).doc(CUSTOMER_DOC_ID).set({
    names,
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return names;
}

/**
 * 客先一覧を取得する。
 * 1. 「客先一覧の編集」で保存した一覧(Firestore)があればそれを使う
 * 2. 無ければ、以前CSVから読み込んでブラウザに保存していた一覧を使う
 * 3. 無ければリポジトリ内の data/customers.csv を読む
 * 戻り値: { list, source: "saved"|"uploaded"|"file"|"default" }
 */
async function loadCustomerList() {
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc(CUSTOMER_DOC_ID).get();
    if (doc.exists && Array.isArray(doc.data().names)) {
      return { list: doc.data().names, source: "saved" };
    }
  } catch (err) {
    // セキュリティルール未更新(permission-denied)などの場合はCSVで代用する
    console.warn("保存済みの客先一覧を取得できませんでした", err);
  }

  const stored = getStoredCustomerList();
  if (stored) return { list: stored, source: "uploaded" };

  try {
    const res = await fetch(CUSTOMER_CSV_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const list = parseCustomerCsvBuffer(await res.arrayBuffer());
    if (list.length > 0) return { list, source: "file" };
  } catch (err) {
    // ローカルファイル(file://)で開いた場合はfetchがブロックされるためここに来る
    console.warn("客先一覧CSVを読み込めませんでした。内蔵の初期リストを使います。", err);
  }
  // CSVが読めない・中身が空のときは内蔵の初期リストで代用する
  return { list: DEFAULT_CUSTOMERS, source: "default" };
}

