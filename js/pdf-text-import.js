/* ==========================================================
   未来栄株式会社 図面管理システム  電子PDFからの読み取り
   ----------------------------------------------------------
   メールで届いた注文書・御見積書・図面のPDF(文字データ入り)を
   ブラウザの中で読み取り、取り込み用ファイル(JSON)と同じ形に組み立てる。
   組み立てた結果は case-import.html の確認表にそのまま渡す。

   スキャン・FAXの画像PDFは文字データが無いため読めない。その場合は
   従来どおりClaude Codeで取り込み用ファイルを作る。

   使う部品(CDN):
     pdf.js  … PDFから文字と位置を取り出す
     pdf-lib … 図面を1ページずつのPDFに切り出す
   ========================================================== */

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/";

/* ---------- 書式の定義 ----------
   客先ごとの注文書の読み方。いまはCAM'Sのみ対応。
   御見積書は外注先の書式だが、表の見出し(品名・数量・単価・金額)で列を
   見つけるので、多少違う書式でも読めることが多い。 */
const PDF_IMPORT_FORMATS = {
  "CAM'S": { parseOrder: parseCamsOrderPage },
};

function pdfImportSupported(customer) {
  return !!PDF_IMPORT_FORMATS[customer];
}

/* ---------- 文字の正規化 ---------- */

// 全角英数字・記号を半角にそろえる(カタカナの長音「ー」はそのまま)
function normalizePdfText(s) {
  return String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[－−‐‑–—]/g, "-")
    .replace(/[，]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[／]/g, "/")
    .replace(/[￥]/g, "¥")
    .replace(/[　]/g, " ");
}

// "¥20,480" / "38,000" / "2" → 数値。数字が無ければnull
function parsePdfNumber(s) {
  const m = String(s || "").replace(/[¥,\s]/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// 品名の比較用(空白・「#2」のような枝番・半角/全角の違いを無視)
function productNameKey(s) {
  return normalizePdfText(s)
    .replace(/#\s*\d+/g, "")
    .replace(/[\s・]/g, "")
    .replace(/[ｰ-]/g, "ー");
}

/* ---------- PDFから文字と位置を取り出す ---------- */

function pdfjsReady() {
  if (!window.pdfjsLib) {
    throw new Error("PDF読み取り部品(pdf.js)を読み込めませんでした。インターネット接続を確認してください。");
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "build/pdf.worker.min.js";
}

/**
 * PDFの各ページの文字を、画面上の位置(左上原点・ポイント単位)つきで取り出す。
 * 戻り値: { bytes, pages: [{ fileName, pageIndex, items:[{str,x,y,w}], rows, text }] }
 */
async function extractPdfPages(file) {
  pdfjsReady();
  const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
  // pdf.jsは渡した配列を使い切ってしまうので、切り出し用にコピーを渡す
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: PDFJS_BASE + "cmaps/",
    cMapPacked: true,
  }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => {
        // ページの回転も含めて、画面に表示したときの位置に直す
        const t = pdfjsLib.Util.transform(viewport.transform, it.transform);
        return { str: normalizePdfText(it.str).trim(), x: t[4], y: t[5], w: it.width || 0 };
      });
    const rows = groupPdfRows(items);
    pages.push({
      fileName: file.name,
      pageIndex: i - 1,
      items,
      rows,
      text: rows.map((r) => r.text).join("\n"),
    });
  }
  return { bytes, pages };
}

// 高さ(y)がほぼ同じ文字を1行にまとめ、左から順に並べる
function groupPdfRows(items, tolerance = 4) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  sorted.forEach((it) => {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.y) <= tolerance) {
      last.items.push(it);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  });
  rows.forEach((r) => {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map((i) => i.str).join(" ");
  });
  return rows;
}

/* ---------- 表の読み方(見出しの位置で列を決める) ---------- */

const compact = (s) => String(s || "").replace(/\s/g, "");

// 必要な見出しがすべて入っている行を探す
function findHeaderRow(rows, required) {
  return rows.findIndex((r) => required.every((k) => compact(r.text).includes(k)));
}

// 見出し行から各列の中心位置を求める
function headerColumns(row, names) {
  const cols = [];
  names.forEach((name) => {
    const it = row.items.find((i) => compact(i.str).includes(name));
    if (it) cols.push({ key: name, x: it.x + it.w / 2 });
  });
  return cols;
}

// 1行の文字を、いちばん近い見出しの列に振り分ける
function rowCells(row, cols) {
  const cells = {};
  row.items.forEach((it) => {
    const c = it.x + it.w / 2;
    let best = cols[0];
    cols.forEach((col) => {
      if (Math.abs(col.x - c) < Math.abs(best.x - c)) best = col;
    });
    cells[best.key] = cells[best.key] ? cells[best.key] + " " + it.str : it.str;
  });
  return cells;
}

/* ---------- ページの種類の判定 ---------- */

// "order" 注文書 / "quote" 御見積書 / "drawing" 図面 / "image" 文字データなし / "unknown"
function classifyPdfPage(page) {
  const t = compact(page.text);
  if (t.length < 10) return "image";
  if (t.includes("注文書") && (t.includes("注文いたします") || t.includes("材質"))) return "order";
  if (t.includes("見積書") && t.includes("単価")) return "quote";
  if (/MN-?\d{4,6}/.test(t)) return "drawing";
  return "unknown";
}

/* ---------- 注文書(CAM'S) ---------- */

// 「令和8年6月2日」「2026年6月2日」「2026/6/2」→ "2026-06-02"
function parseJapaneseDate(text) {
  const t = normalizePdfText(text);
  let m = t.match(/(令和|R)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${2018 + Number(m[2])}-${pad2(m[3])}-${pad2(m[4])}`;
  m = t.match(/(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return "";
}

function parseCamsOrderPage(page) {
  const rows = page.rows;
  const text = page.text;

  // 伝票番号は「伝票番号 担当」の見出しのすぐ下の行にある
  let slipNo = "";
  const slipHead = rows.findIndex((r) => compact(r.text).includes("伝票番号"));
  for (let k = slipHead; slipHead >= 0 && k < Math.min(rows.length, slipHead + 3); k++) {
    const m = rows[k].text.match(/\b(\d{4,6}(?:-\d{1,2})?)\b/);
    if (m) {
      slipNo = m[1];
      break;
    }
  }
  const dateLine = rows.find((r) => compact(r.text).includes("発行日"));
  const orderDate = parseJapaneseDate(dateLine ? dateLine.text : text);

  const h = findHeaderRow(rows, ["材質", "個数", "金額"]);
  if (h < 0) throw new Error(`${page.fileName} ${page.pageIndex + 1}ページ：注文書の表の見出しが見つかりません。`);
  const cols = headerColumns(rows[h], ["部品名", "材質", "個数", "単価", "金額", "備考"]);
  if (!cols.some((c) => c.key === "部品名")) cols.unshift({ key: "部品名", x: rows[h].items[0].x });

  const lines = [];
  let total = null;
  let lastCode = "";
  for (let k = h + 1; k < rows.length; k++) {
    const row = rows[k];
    if (compact(row.text).startsWith("合計") || /^合計/.test(compact(row.items[0].str))) {
      total = parsePdfNumber(row.text.replace(/合計/, ""));
      continue;
    }
    const cells = rowCells(row, cols);
    // 左の列は「行番号 図面番号 部品名」(番号と品名がくっついて入っていることもある)
    const m = (cells["部品名"] || "").match(/(?:^|\s)(\d{4,6})\s*([^\d\s].*)$/);
    if (!m) continue;
    const code = ((cells["備考"] || "").match(/[A-Z]{2,}-?\d{2,}/) || [])[0];
    if (code) lastCode = code; // 品番は1行目だけに書かれ、下は矢印で省略されている
    const qty = parsePdfNumber(cells["個数"]);
    const unit = parsePdfNumber(cells["単価"]);
    const amount = parsePdfNumber(cells["金額"]);
    lines.push({
      drawingNo: m[1],
      productName: m[2].trim(),
      material: (cells["材質"] || "").trim(),
      qty: qty || 0,
      // 単価欄が空で金額だけの行は、金額÷数量を単価とする
      orderUnitPrice: unit !== null ? unit : amount !== null && qty ? amount / qty : null,
      orderAmount: amount,
      productCode: lastCode,
      orderSlipNo: slipNo,
      orderDate,
      page: page.pageIndex + 1,
      fileName: page.fileName,
    });
  }
  return { slipNo, orderDate, total, lines };
}

/* ---------- 御見積書 ---------- */

function parseQuotePage(page) {
  const rows = page.rows;
  const text = page.text;

  const noMatch = text.match(/見積\s*No\.?\s*[:：]?\s*([0-9A-Z-]{4,})/i);
  const quoteNo = noMatch ? noMatch[1] : "";
  const quoteDate = parseJapaneseDate(text);

  // 外注先の社名。宛先の未来栄は除く。ロゴ画像の場合は「(株)○○では」の文から拾う
  let outsourcer = "";
  const names = text.match(/株式会社\s*[^\s、。()（）]+|[^\s、。()（）]+\s*株式会社/g) || [];
  const other = names.map((n) => n.replace(/\s/g, "")).find((n) => !n.includes("未来栄"));
  if (other) outsourcer = other;
  if (!outsourcer) {
    const m = text.match(/[（(]株[）)]\s*([ァ-ヶー]+)/);
    if (m) outsourcer = "株式会社" + m[1];
  }

  const totalMatch = compact(text).match(/合計¥?([\d,]+)/);
  const total = totalMatch ? parsePdfNumber(totalMatch[1]) : null;

  const h = findHeaderRow(rows, ["品名", "数量", "単価", "金額"]);
  if (h < 0) throw new Error(`${page.fileName} ${page.pageIndex + 1}ページ：御見積書の表の見出しが見つかりません。`);
  const cols = headerColumns(rows[h], ["No", "品番", "品名", "R/L", "数量", "単位", "単価", "金額", "備考"]);

  const lines = [];
  for (let k = h + 1; k < rows.length; k++) {
    const row = rows[k];
    const t = compact(row.text);
    if (t.includes("注意事項") || t.startsWith("小計")) break;
    const cells = rowCells(row, cols);
    const unit = parsePdfNumber(cells["単価"]);
    const qty = parsePdfNumber(cells["数量"]);
    // 品名が長いとR/L欄にはみ出すので、2つの欄をまとめてから「R/L各1個」などの注記を除く
    const nameCell = [cells["品名"], cells["R/L"]].filter(Boolean).join(" ")
      .replace(/R\/L\s*各?/g, " ")
      .replace(/(^|\s)\d+\s*個(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (unit === null || !nameCell) continue; // 「R/L各1個」の折り返しなど
    const dm = nameCell.match(/MN\s*-?\s*(\d{4,6})/);
    lines.push({
      drawingNo: dm ? dm[1] : "",
      productName: (dm ? nameCell.replace(dm[0], "") : nameCell).trim(),
      productCode: ((cells["品番"] || "").match(/[A-Z]{2,}-?\d{2,}/) || [""])[0],
      qty: qty || 0,
      unitPrice: unit,
      quoteNo,
      quoteDate,
      outsourcer,
    });
  }
  return { quoteNo, quoteDate, outsourcer, total, lines };
}

/* ---------- 図面 ---------- */

// 図面のタイトル欄の「図番 MN-10202」を探す。複数あるときは右下に近いものを選ぶ
function parseDrawingPage(page) {
  const hits = [];
  page.items.forEach((it) => {
    const m = it.str.replace(/\s/g, "").match(/MN-?(\d{4,6})/);
    if (m) hits.push({ no: m[1], score: it.x + it.y });
  });
  if (hits.length === 0) {
    // 「MN」と番号が別々の文字として入っている場合
    const m = compact(page.text).match(/MN-?(\d{4,6})/);
    return m ? m[1] : "";
  }
  hits.sort((a, b) => b.score - a.score);
  return hits[0].no;
}

/* ---------- PDFのページを切り出す ---------- */

async function copyPdfPages(sources) {
  if (!window.PDFLib) throw new Error("PDF切り出し部品(pdf-lib)を読み込めませんでした。");
  const out = await PDFLib.PDFDocument.create();
  const cache = new Map();
  for (const { bytes, pageIndex } of sources) {
    if (!cache.has(bytes)) cache.set(bytes, await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }));
    const [p] = await out.copyPages(cache.get(bytes), [pageIndex]);
    out.addPage(p);
  }
  const data = await out.save();
  return { base64: arrayBufferToBase64(data), fileSize: data.length };
}

/* ---------- 突き合わせ ---------- */

/**
 * 注文書の行と御見積書の行を図面番号で突き合わせる。
 *  1. 図面番号と品名がどちらも一致する行
 *  2. 品名だけが一致する、図面番号の無い(または食い違う)見積行
 *  3. 図面番号だけ一致する行(品名の違いを「要確認」にする)
 * 同じ図面番号の見積行が複数(「#2」などで分かれている)なら数量を合計する。
 */
function matchOrderAndQuote(orderLines, quoteLines) {
  const used = new Set();
  const take = (filter, limit = Infinity) => {
    const hits = quoteLines.filter((q, i) => !used.has(i) && filter(q)).slice(0, limit);
    hits.forEach((q) => used.add(quoteLines.indexOf(q)));
    return hits;
  };
  const sameCode = (o, q) => !q.productCode || !o.productCode || q.productCode === o.productCode;

  const results = orderLines.map((o) => ({ o, q: [], how: "" }));
  results.forEach((r) => {
    r.q = take((q) => sameCode(r.o, q) && q.drawingNo === r.o.drawingNo &&
      productNameKey(q.productName) === productNameKey(r.o.productName));
    if (r.q.length) r.how = "exact";
  });
  results.forEach((r) => {
    if (r.q.length) return;
    r.q = take((q) => sameCode(r.o, q) && q.drawingNo !== r.o.drawingNo &&
      !orderLines.some((o2) => o2 !== r.o && o2.drawingNo === q.drawingNo && productNameKey(o2.productName) === productNameKey(q.productName)) &&
      productNameKey(q.productName) === productNameKey(r.o.productName));
    if (r.q.length) r.how = "name";
  });
  results.forEach((r) => {
    if (r.q.length) return;
    r.q = take((q) => sameCode(r.o, q) && q.drawingNo === r.o.drawingNo);
    if (r.q.length) r.how = "number";
  });
  // 4. 見積書で数量が足りない行に、同じ品名で残っている見積行を足す
  //    (例: 注文2個の部品が、見積書では別の図面番号を付けた1個ずつの2行になっている)
  results.forEach((r) => {
    if (!r.q.length) return;
    const quoted = () => r.q.reduce((t, q) => t + (q.qty || 0), 0);
    while (quoted() < r.o.qty) {
      const extra = take((q) => sameCode(r.o, q) && q.unitPrice === r.q[0].unitPrice &&
        productNameKey(q.productName) === productNameKey(r.o.productName), 1);
      if (!extra.length) break;
      r.q.push(...extra);
      r.split = true;
    }
  });

  const unused = quoteLines.filter((q, i) => !used.has(i));
  return { results, unused };
}

/* ---------- 取り込み用データの組み立て ---------- */

/**
 * PDFファイル(複数可)を読み取り、取り込み用ファイルと同じ形のデータを返す。
 * onProgress(message)
 */
async function buildCaseBundleFromPdfs(files, customer, onProgress) {
  const format = PDF_IMPORT_FORMATS[customer];
  if (!format) throw new Error(`${customer} の注文書の書式にはまだ対応していません。`);
  const say = (m) => onProgress && onProgress(m);

  const pages = [];
  const imagePages = [];
  const unknownPages = [];
  for (const file of files) {
    say(`${file.name} を読み取っています…`);
    const { bytes, pages: ps } = await extractPdfPages(file);
    ps.forEach((p) => {
      p.bytes = bytes;
      p.kind = classifyPdfPage(p);
      pages.push(p);
      if (p.kind === "image") imagePages.push(p);
      if (p.kind === "unknown") unknownPages.push(p);
    });
  }

  const orderPages = pages.filter((p) => p.kind === "order");
  const quotePages = pages.filter((p) => p.kind === "quote");
  const drawingPages = pages.filter((p) => p.kind === "drawing");
  const pageLabel = (p) => `${p.fileName} ${p.pageIndex + 1}ページ`;

  if (orderPages.length === 0) {
    if (imagePages.length === pages.length) {
      throw new Error("選んだPDFには文字データがありません（スキャン・FAXの画像PDFです）。" +
        "この場合はClaude Codeで取り込み用ファイルを作ってください。");
    }
    throw new Error("注文書のページが見つかりませんでした。注文書のPDFも一緒に選んでください。");
  }

  say("注文書と御見積書を突き合わせています…");
  const orders = orderPages.map((p) => format.parseOrder(p));
  const quotes = quotePages.map((p) => parseQuotePage(p));
  const orderLines = orders.flatMap((o) => o.lines);
  const quoteLines = quotes.flatMap((q) => q.lines);
  const { results, unused } = matchOrderAndQuote(orderLines, quoteLines);

  // 図面番号 → 図面のページ
  const drawingByNo = new Map();
  drawingPages.forEach((p) => {
    const no = parseDrawingPage(p);
    if (no && !drawingByNo.has(no)) drawingByNo.set(no, p);
  });

  const warnings = [];
  const items = [];
  for (const { o, q, how } of results) {
    const notes = [];
    if (o.orderUnitPrice === null) notes.push("注文書に単価・金額の記載がありません（手書きなら表に入力してください）。");
    if (!o.productCode) notes.push("注文書の備考欄に品番が見つかりません。");
    if (/^[*＊\s]*$/.test(o.productName)) notes.push("注文書の品名が「*」（未記入）です。");

    let outsourceUnitPrice = null;
    let outsourceQty = 0;
    let first = q[0];
    if (q.length === 0) {
      notes.push("御見積書に対応する行が見つかりません。");
    } else {
      const prices = Array.from(new Set(q.map((x) => x.unitPrice)));
      outsourceUnitPrice = prices[0];
      outsourceQty = q.reduce((t, x) => t + (x.qty || 0), 0);
      if (prices.length > 1) notes.push(`御見積書に単価の違う行が複数あります（${prices.map(formatYen).join("・")}）。`);
      if (q.length > 1) {
        const labels = q.map((x) => (x.drawingNo ? "MN-" + x.drawingNo + " " : "") + x.productName);
        notes.push(`御見積書では${q.length}行に分かれています（${labels.join("／")}）。`);
      }
      if (how === "name") notes.push(`御見積書の図面番号は「${first.drawingNo || "記載なし"}」でしたが、品名で対応づけました。`);
      if (how === "number") notes.push(`御見積書の品名は「${first.productName}」です。`);
      if (outsourceQty && outsourceQty !== o.qty) notes.push(`注文数量は${o.qty}個ですが、御見積書の数量は${outsourceQty}個です。`);
    }

    let drawing = null;
    const dp = drawingByNo.get(o.drawingNo);
    if (dp) {
      const pdf = await copyPdfPages([{ bytes: dp.bytes, pageIndex: dp.pageIndex }]);
      drawing = { page: dp.pageIndex + 1, fileName: `${o.productCode || "図面"}_MN-${o.drawingNo}.pdf`, ...pdf };
    } else {
      notes.push("図面のページが見つかりません。");
    }

    items.push({
      productCode: o.productCode,
      productName: o.productName,
      drawingNo: o.drawingNo,
      material: o.material,
      qty: o.qty,
      orderUnitPrice: o.orderUnitPrice === null ? "" : o.orderUnitPrice,
      orderSlipNo: o.orderSlipNo,
      orderDate: o.orderDate,
      outsourceUnitPrice: outsourceUnitPrice === null ? "" : outsourceUnitPrice,
      outsourceQty,
      outsourcer: first ? first.outsourcer : "",
      quoteNo: first ? first.quoteNo : "",
      quoteDate: first ? first.quoteDate : "",
      needsCheck: notes.length > 0,
      note: notes.join(""),
      drawing,
    });
  }

  unused.forEach((q) => warnings.push(
    `御見積書 ${q.quoteNo} の「${q.drawingNo ? "MN-" + q.drawingNo + " " : ""}${q.productName}」（${formatYen(q.unitPrice)}）は、注文書のどの行とも対応づけられませんでした。`));
  imagePages.forEach((p) => warnings.push(`${pageLabel(p)} は文字データのない画像のため読み取れませんでした。`));
  unknownPages.forEach((p) => warnings.push(`${pageLabel(p)} は注文書・御見積書・図面のどれか判定できませんでした。`));
  const usedDrawing = new Set(items.map((it) => it.drawingNo));
  drawingByNo.forEach((p, no) => {
    if (!usedDrawing.has(no)) warnings.push(`${pageLabel(p)} の図面（MN-${no}）は注文書にない図面番号です。`);
  });
  if (orderLines.length === 0) warnings.push("注文書の表から明細を読み取れませんでした。");

  // 紙(PDF)に書かれた合計との照合用
  const slipTotals = {};
  orders.forEach((o) => {
    if (o.slipNo && o.total) slipTotals[o.slipNo] = o.total;
  });
  const quoteTotals = {};
  quotes.forEach((q) => {
    if (q.quoteNo && q.total) quoteTotals[q.quoteNo] = q.total;
  });

  // 元の注文書・御見積書を1つのPDFにまとめて残す
  say("注文書・御見積書のPDFをまとめています…");
  const docPdf = await copyPdfPages([...orderPages, ...quotePages].map((p) => ({ bytes: p.bytes, pageIndex: p.pageIndex })));
  const fileNames = Array.from(new Set(pages.map((p) => p.fileName)));

  return {
    format: CASE_IMPORT_FORMAT,
    version: 1,
    customer,
    sourceFile: fileNames.join(" / "),
    createdAt: new Date().toISOString().slice(0, 10),
    slipTotals,
    quoteTotals,
    warnings,
    document: {
      title: `注文書・御見積書（${fileNames.join("、")}）`,
      fileName: `${(orders[0] && orders[0].lines[0] && orders[0].lines[0].productCode) || customer}_注文書・御見積書.pdf`,
      ...docPdf,
    },
    // 品番が読めなかった行も保存できるよう仮の品番を入れておく(要確認の印つき)
    items: items.map((it) => (it.productCode ? it : { ...it, productCode: "(品番不明)" })),
  };
}
