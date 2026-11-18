/* ==========================================================
   未来栄株式会社 図面管理システム  注文書・材料注文書・納品書
   ----------------------------------------------------------
   これまでExcel(「出荷済 MDA-○○○○○○○ 客先.xlsx」)で作っていた書類を、
   案件ページから作って印刷・PDF保存する。

     purchaseOrders/{id} … 下請け・材料屋への注文書1枚。
                            案件キー・受注№・宛先・納入先・明細行など
   注文書の明細行のうち、表の行(caseItems)と結びつけたものは、その行の
   外注の内訳(costs)に自動で入る(poId付き)。注文書を直す・消すと内訳も直る。

   受注№(例 MDA2607023)は取引(orders.orderNo)に持つ。
   「MDA＋受注日の年2桁＋月2桁＋その月の連番3桁」で自動採番し、手で直せる。
   ========================================================== */

const PO_COLLECTION = "purchaseOrders";

// 書類に印字する未来栄の情報
const COMPANY = {
  name: "未来栄株式会社",
  head: { label: "本社", zip: "〒910-0369", address: "福井県坂井市丸岡町新九頭竜2-150-1", tel: "0776-97-9677", fax: "0776-97-9678" },
  factory: { label: "工場", zip: "〒919-0461", address: "福井県坂井市春江町江留上緑29", tel: "0776-50-7505", fax: "0776-50-7506" },
};

// 納入先の選択肢(弊社工場が既定)
const OWN_DESTINATIONS = [
  { key: "factory", name: "弊社工場", tel: COMPANY.factory.tel, address: `${COMPANY.factory.zip}　${COMPANY.factory.address}` },
  { key: "head", name: "弊社", tel: COMPANY.head.tel, address: `${COMPANY.head.zip}　${COMPANY.head.address}` },
];

// 注文書の宛先と、直送するときの納入先の候補になる外注先・材料屋は、
// case-store.js の PARTNER_VENDORS(Firestore の settings/partners から読む)。
// short はExcelの「メーカー」「手配先」欄に入れていた略称。
// 納品書の宛名(CUSTOMER_FORMAL_NAMES)も同じ場所から読む。

const PO_KINDS = { order: "注文書", material: "材料注文書" };

// 材料注文書の宛先の候補(材料屋。2026-11-16 社長のリクエスト)
const MATERIAL_VENDORS = ["カラヤ㈱", "㈱金太", "㈱伸栄商会", "北鋼シャーリング㈱"];

/* ---------- 外注先 ---------- */

// 登録済みの外注先＋これまでの注文書に出てきた外注先(新しい情報を優先)
function knownVendors(pos) {
  const map = new Map(PARTNER_VENDORS.map((v) => [v.name, { ...v }]));
  (pos || []).forEach((po) => {
    if (!po.vendor) return;
    const v = map.get(po.vendor) || { name: po.vendor, short: "", tel: "", address: "" };
    if (po.vendorShort) v.short = po.vendorShort;
    map.set(po.vendor, v);
    // 直送先として使った住所・電話も覚えておく
    const dest = po.deliverTo;
    if (dest && dest.name && !OWN_DESTINATIONS.some((o) => o.name === dest.name)) {
      const dv = map.get(dest.name) || { name: dest.name, short: "", tel: "", address: "" };
      if (dest.tel) dv.tel = dest.tel;
      if (dest.address) dv.address = dest.address;
      map.set(dest.name, dv);
    }
  });
  return Array.from(map.values());
}

/* ---------- 読み書き ---------- */

async function fetchAllPurchaseOrders() {
  const snapshot = await db.collection(PO_COLLECTION).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function fetchCasePurchaseOrders(caseKey) {
  return (await fetchAllPurchaseOrders()).filter((po) => po.caseKey === caseKey);
}

function poTotal(po) {
  return (po.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
}

/**
 * 案件の受注金額・仕入原価・粗利(Excelの受発注書の右上と同じ考え方)。
 *   受注金額 = 表の行の 受注単価×数量 の合計(行が無いときは案件の金額(税抜))
 *   仕入原価 = 外注費(注文書の合計) + 工場仕入(材料注文書の合計) + 手入力の外注単価(注文書から入ったもの以外)
 * 注文書から表の行に入った外注単価(poId のある内訳)は、注文書の合計で数えるので二重に足さない。
 * rows: 案件の表の行、pos: 案件の注文書、fallbackAmount: 案件の金額(税抜)、makeType: 案件の区分(工場／工場＋外注／外注)
 *
 * 工場分(Excelの「工場」タブの右上)も出す。
 *   工場の受注金額 = 工場で作る行の 受注単価×数量
 *   工場の原価     = 工場分の注文書・材料注文書 + 工場で作る行の手入力の外注単価
 *   行の工場／外注は rowMakeBy()、注文書の工場分／外注分は poSection() で決める。
 */
// 行(品物)を工場で作るか。行に指定が無ければ案件の区分に従う(工場＋外注で未指定なら "")
function rowMakeBy(row, makeType) {
  if (row.makeBy === "工場" || row.makeBy === "外注") return row.makeBy;
  if (makeType === "工場") return "工場";
  if (makeType === "外注") return "外注";
  return "";
}

// 注文書が工場分か外注分か。指定が無ければ、材料注文書と「工場のみ」の案件は工場分、
// 結びつけた行がすべて工場で作る行なら工場分、それ以外は外注分
function poSection(po, rows, makeType) {
  if (po.section === "工場" || po.section === "外注") return po.section;
  if (po.kind === "material" || makeType === "工場") return "工場";
  const linked = (po.lines || []).map((l) => rows.find((r) => r.id === l.itemId)).filter(Boolean);
  return linked.length && linked.every((r) => rowMakeBy(r, makeType) === "工場") ? "工場" : "外注";
}

function caseProfit(rows, pos, fallbackAmount, makeType) {
  const qtyOf = (r) => Number(r.qty) || 0;
  const orderOf = (r) => (Number(r.orderUnitPrice) || 0) * qtyOf(r);
  const manualOf = (r) => {
    const costs = caseCostLines(r);
    if (!costs.length) return (Number(r.outsourceUnitPrice) || 0) * qtyOf(r);
    const perPiece = costs.filter((c) => !isReferenceCost(c) && !c.poId).reduce((s, c) => s + (Number(c.unitPrice) || 0), 0);
    return perPiece * qtyOf(r);
  };
  const sum = (list, fn) => list.reduce((t, x) => t + fn(x), 0);
  const rate = (order, profit) => (order ? (profit / order) * 100 : null);
  const amount = typeof fallbackAmount === "number" ? fallbackAmount : 0;

  const fromRows = sum(rows, orderOf);
  const orderTotal = fromRows || amount;
  const outsourcePo = sum(pos.filter((p) => p.kind !== "material"), poTotal);
  const materialPo = sum(pos.filter((p) => p.kind === "material"), poTotal);
  const manual = sum(rows, manualOf);
  const cost = outsourcePo + materialPo + manual;
  const profit = orderTotal - cost;

  // 工場分
  const factoryRows = rows.filter((r) => rowMakeBy(r, makeType) === "工場");
  const factoryPos = pos.filter((p) => poSection(p, rows, makeType) === "工場");
  const fOrder = rows.length ? sum(factoryRows, orderOf) : (makeType === "工場" ? amount : 0);
  const fCost = sum(factoryPos, poTotal) + sum(factoryRows, manualOf);
  const factory = {
    orderTotal: fOrder, cost: fCost, profit: fOrder - fCost, rate: rate(fOrder, fOrder - fCost),
    rowCount: factoryRows.length,
    unsetCount: rows.filter((r) => rowMakeBy(r, makeType) === "").length, // 工場か外注か決まっていない行
    has: makeType === "工場" || makeType === "工場＋外注" || factoryRows.length > 0 || factoryPos.length > 0,
  };
  return { orderTotal, outsourcePo, materialPo, manual, cost, profit, rate: rate(orderTotal, profit), factory };
}

/**
 * 注文書を保存し、表の行の外注の内訳に反映する。
 * po: { id?, caseKey, kind, vendor, vendorShort, issueDate, orderNo, deliverTo, remarks, shipNote, lines[] }
 * rows: この案件の表の行(caseItems)。反映した結果で書き換えて返す。
 */
async function savePurchaseOrder(po, rows) {
  const ref = po.id ? db.collection(PO_COLLECTION).doc(po.id) : db.collection(PO_COLLECTION).doc();
  const data = { ...po };
  delete data.id;
  data.updatedBy = auth.currentUser ? auth.currentUser.email : "";
  data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await ref.set(data);
  const saved = { id: ref.id, ...data };
  await syncPurchaseOrderCosts(saved, rows);
  return saved;
}

async function deletePurchaseOrder(po, rows) {
  await db.collection(PO_COLLECTION).doc(po.id).delete();
  await syncPurchaseOrderCosts({ ...po, lines: [] }, rows);
}

/**
 * 注文書の明細のうち、表の行と結びついたものを、その行の外注の内訳(costs)に入れる。
 * 同じ注文書から入れた内訳(poIdが同じもの)は、いったん外してから入れ直す。
 * 単価は「注文書の金額 ÷ 部品の数量」で1個あたりにする(材料を4本まとめて注文した場合など)。
 */
async function syncPurchaseOrderCosts(po, rows) {
  const touched = new Set();
  rows.forEach((r) => {
    if (caseCostLines(r).some((c) => c.poId === po.id)) touched.add(r.id);
  });
  (po.lines || []).forEach((l) => { if (l.itemId) touched.add(l.itemId); });

  for (const id of touched) {
    const r = rows.find((x) => x.id === id);
    if (!r) continue;
    let costs = caseCostLines(r).filter((c) => c.poId !== po.id);
    // 内訳を作る前に手入力されていた外注単価は、消さずに内訳の1行として残す
    if (!caseCostLines(r).length && r.outsourceUnitPrice !== null && r.outsourceUnitPrice !== undefined && r.outsourceUnitPrice !== "") {
      costs = [{ vendor: r.outsourcer || "", process: "（手入力していた外注単価）", unitPrice: Number(r.outsourceUnitPrice), qty: r.qty || 0, quoteNo: "", ref: "", kind: "" }];
    }
    (po.lines || []).forEach((l, i) => {
      if (l.itemId !== id) return;
      const amount = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
      const perPiece = r.qty ? Math.round(amount / r.qty) : Number(l.unitPrice) || 0;
      const process = po.kind === "material"
        ? `材料（${[l.name, l.size, l.material].filter(Boolean).join(" ")}）`
        : (l.spec || "外注加工");
      costs.push({
        vendor: po.vendorShort || po.vendor, process, unitPrice: perPiece, qty: r.qty || Number(l.qty) || 0,
        quoteNo: "", ref: `${PO_KINDS[po.kind] || "注文書"} ${po.orderNo || ""}（${formatOrderDate(po.issueDate)}）`,
        kind: "", poId: po.id, poLine: i,
      });
    });
    const fields = {
      costs,
      outsourceUnitPrice: costs.length ? sumCostLines(costs) : null,
      outsourcer: costVendors(costs).join("、"),
      outsourceQty: r.qty || 0,
    };
    await updateCaseItem(id, fields);
    Object.assign(r, fields);
  }
}

/* ---------- 印影(担当者印) ----------
   公開しているアプリのファイルには入れず、ログインした人だけが読める
   Firestore の settings/seal に画像(dataURL)で保存する。
   2026-11-16 から複数登録できる：seals = [{ name: "中嶋", image: "data:..." }, …]。
   注文書を作るときに「押印」で名前を選び、注文書に sealName として保存する。
   前の形(image が1つだけ)で登録した印は「登録済みの印」という名前で扱う。 */
const LEGACY_SEAL_NAME = "登録済みの印";
const SEAL_PICK_KEY = "miraiei.sealName";

async function loadSeals() {
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc("seal").get();
    if (!doc.exists) return [];
    const d = doc.data();
    const list = Array.isArray(d.seals) ? d.seals.filter((s) => s && s.name && s.image) : [];
    if (!list.length && d.image) list.push({ name: LEGACY_SEAL_NAME, image: d.image });
    return list;
  } catch (err) {
    console.warn("印影を読み込めませんでした", err);
    return [];
  }
}

async function saveSeals(list) {
  await db.collection(SETTINGS_COLLECTION).doc("seal").set({
    seals: list.map((s) => ({ name: s.name, image: s.image })),
    image: firebase.firestore.FieldValue.delete(),
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// 注文書に押す印の画像。sealName が "" なら押さない。
// sealName の無い前の注文書は、登録した印が1つだけならそれを押す(これまでと同じ)
function sealImageFor(po, seals) {
  if (po.sealName === undefined || po.sealName === null) return seals.length === 1 ? seals[0].image : "";
  const s = seals.find((x) => x.name === po.sealName);
  return s ? s.image : "";
}

function lastSealName() {
  try { return localStorage.getItem(SEAL_PICK_KEY) || ""; } catch (e) { return ""; }
}

function rememberSealName(name) {
  try { localStorage.setItem(SEAL_PICK_KEY, name || ""); } catch (e) { /* 覚えられなくても注文書は作れる */ }
}

// 画像ファイルを小さめのPNGのdataURLにする(印影は小さいので最大300px)
function imageFileToDataUrl(file, maxEdge = 300) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした"));
    };
    img.src = url;
  });
}

/* ==========================================================
   印刷用の書類(HTML)。Excelの書式に合わせている。
   ========================================================== */

const yen = (n) => (n === null || n === undefined || n === "" || isNaN(n) ? "" : Number(n).toLocaleString("ja-JP"));

// "2026-08-24" → 「2026年8月24日」
function jpDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : "";
}

// "2026-09-08" → 「2026/9/8」
function slashDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : "";
}

/* 本社・工場の住所の前の□。選んだほうを■(黒く塗りつぶす)にする(2026-11-16 社長のリクエスト。作る書類すべて)。
   mark: "head"(本社)・"factory"(工場)・""(塗らない) */
const ADDR_MARKS = [
  { value: "", label: "塗らない（□のまま）" },
  { value: "head", label: "本社を■にする" },
  { value: "factory", label: "工場を■にする" },
];
const ADDR_MARK_KEY = "miraiei.addrMark";

// 前に選んだものを既定にする(この端末だけ。使えないときは「塗らない」)
function lastAddrMark() {
  try { return localStorage.getItem(ADDR_MARK_KEY) || ""; } catch (e) { return ""; }
}

function rememberAddrMark(mark) {
  try { localStorage.setItem(ADDR_MARK_KEY, mark || ""); } catch (e) { /* 保存できなくても印刷はできる */ }
}

// 選択欄(<select>)に選択肢を入れる。value を省くと前に選んだもの
function fillAddrMarkSelect(sel, value) {
  sel.innerHTML = ADDR_MARKS.map((m) => `<option value="${m.value}">${m.label}</option>`).join("");
  sel.value = value === undefined || value === null ? lastAddrMark() : value;
}

/* ---------- Excelのシートをそのまま再現する(2026-11-18) ----------
   Excel(「出荷済 MDA-2607-023　DID●.xlsx」の受発注書・工場・納品書シート)の
   列の幅・行の高さ・文字の大きさ・罫線・結合セルを、セル番地のまま書き写して表にする。
   寸法はExcelの値(pt)で書き、印刷したExcel(PDF)と同じ大きさになるように
   横 sx・縦 sy・文字 sf を掛ける(Excelは印刷すると、横・縦・文字で縮み方が少し違うため)。 */

// "B26" → { r: 行(0から), c: 列(0から) }。base は表の1行目にあたるExcelの行番号
function xlAddr(a, base) {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  return { c: m[1].split("").reduce((t, ch) => t * 26 + ch.charCodeAt(0) - 64, 0) - 1, r: Number(m[2]) - base };
}

/* sheet: { cols:[幅pt], rows:[高さpt], base:1行目のExcel行番号, sx, sy, sf, cells:[[番地, 中身html, 書式]], overlays:[{x,y,w,h,html}] }
   書式: fs 文字pt(既定10)・al "l"|"c"|"r"・va "t"|"m"|"b"・bd 罫線 "lrtb" の組合せ・fill 灰色・u 下線・color・wrap 折り返し */
function xlSheetHtml(sheet) {
  const { cols, rows, base, sx, sy, sf, cells, overlays = [], cls = "" } = sheet;
  const pt = (v) => `${Math.round(v * 100) / 100}pt`;
  const grid = rows.map(() => cols.map(() => null));
  cells.forEach(([ref, html, f = {}]) => {
    const [a, b = a] = ref.split(":");
    const p = xlAddr(a, base), q = xlAddr(b, base);
    const cell = { html, f, rs: q.r - p.r + 1, cs: q.c - p.c + 1 };
    for (let r = p.r; r <= q.r; r++) for (let c = p.c; c <= q.c; c++) grid[r][c] = "x";
    grid[p.r][p.c] = cell;
  });
  const AL = { l: "left", c: "center", r: "right" };
  const VA = { t: "top", m: "middle", b: "bottom" };
  const LINE = "0.75pt solid #000";
  const td = (cell) => {
    if (cell === "x") return "";
    if (!cell) return "<td></td>";
    const f = cell.f;
    const st = [`font-size:${pt((f.fs || 10) * sf)}`];
    if (f.al) st.push(`text-align:${AL[f.al]}`);
    if (f.va && f.va !== "m") st.push(`vertical-align:${VA[f.va]}`);
    const bd = f.bd || "";
    if (bd.includes("l")) st.push(`border-left:${LINE}`);
    if (bd.includes("r")) st.push(`border-right:${LINE}`);
    if (bd.includes("t")) st.push(`border-top:${LINE}`);
    if (bd.includes("b")) st.push(`border-bottom:${LINE}`);
    if (f.color) st.push(`color:${f.color}`);
    const klass = [f.fill ? "xl-fill" : "", f.u ? "xl-u" : "", f.wrap ? "xl-wrap" : ""].filter(Boolean).join(" ");
    return `<td${cell.rs > 1 ? ` rowspan="${cell.rs}"` : ""}${cell.cs > 1 ? ` colspan="${cell.cs}"` : ""}${klass ? ` class="${klass}"` : ""} style="${st.join(";")}">${cell.html ?? ""}</td>`;
  };
  const width = cols.reduce((t, w) => t + w, 0) * sx;
  return `
    <div class="xl-sheet ${cls}" style="width:${pt(width)}">
      <table class="xl-grid" style="width:${pt(width)}">
        <colgroup>${cols.map((w) => `<col style="width:${pt(w * sx)}">`).join("")}</colgroup>
        <tbody>${rows.map((h, r) => `<tr style="height:${pt(h * sy)}">${grid[r].map(td).join("")}</tr>`).join("")}</tbody>
      </table>
      ${overlays.map((o) => `<div class="xl-over" style="left:${pt(o.x * sx)};top:${pt(o.y * sy)};width:${pt(o.w * sx)};height:${pt(o.h * sy)}">${o.html}</div>`).join("")}
    </div>`;
}

// 本社・工場の住所の行(□は、選んだほうを■にする)。注文書は□だけ少し大きい(Excelと同じ)
const addrLine = (mark, key, bigBox) =>
  ` ${bigBox ? `<span style="font-size:1.1em">${mark === key ? "■" : "□"}</span>` : mark === key ? "■" : "□"} ${COMPANY[key].label}　${COMPANY[key].zip} ${COMPANY[key].address}`;
const telLine = (key) => `TEL ${COMPANY[key].tel}　 FAX ： ${COMPANY[key].fax}`;
const LOGO_HTML = `<img class="xl-logo" src="img/logo.jpg" alt="未来栄株式会社">`;

// 明細の納期。カレンダーで選んだ「2026-11-20」は「11/20」と印刷する。前に手入力した文字はそのまま
function poDueText(due) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(due || ""));
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(due || "");
}

// Excelの「#,##0_ 」(数字のあとに半角1つ分あける)
const xlNum = (n) => (n === "" || n === null || n === undefined || isNaN(n) ? "" : `${yen(n)}&nbsp;`);

// 注文書・材料注文書(A4横)。注文書はExcelの「受発注書」シート24〜46行、材料注文書は「工場」シート24〜47行と同じ。
// 列：№・図面№/部品名称(名称)・表示型式(SIZE)・材質・数量(数・単位)・ﾒｰｶｰ・手配先・単価・金額・納期
function purchaseOrderHtml(po, sealImage) {
  const material = po.kind === "material";
  const mark = po.addrMark || "";
  const ROWS = 11;
  const lines = (po.lines || []).slice();
  while (lines.length < ROWS) lines.push(null);
  // 1枚目の行の位置。材料注文書は表題の行が1行多い(「工場」シートと同じ)
  const T = 24;                      // 表題の行
  const o = material ? 1 : 0;        // 材料注文書は宛名から下が1行ずつ下がる
  const H = 30 + o;                  // 明細の見出しの行
  const L = H + 1;                   // 明細の1行目
  const E = L + lines.length;        // total の行
  const B = E + 1;                   // 納入先・備考欄の1行目
  const D = material ? 12 : 10;      // 明細の名称・型式・材質・数量の文字(材料注文書は見間違えないように大きく。Excelと同じ)
  const cells = [];
  const c = (ref, html, f) => cells.push([ref, html, f]);

  // 表題・日付
  if (material) c(`G${T}:L${T}`, " 材 料 注 文 書 ", { fs: 20, al: "c" });
  else c(`C${T}:F${T}`, "　注　文　書", { fs: 16 });
  c(`R${T + o}:S${T + o + 1}`, escapeHtml(jpDate(po.issueDate)), { al: "r", u: true });
  // 宛名
  c(`B${25 + o}:E${25 + o}`, escapeHtml(po.vendor || ""), { fs: 12, al: "c", bd: "b" });
  c(`F${25 + o}:G${25 + o}`, " 御中");
  c(`B${26 + o}:E${26 + o}`, escapeHtml(po.vendorPerson || ""), { fs: 12, al: "c", bd: "b" });
  c(`F${26 + o}:G${26 + o}`, " 様");
  c(`A${27 + o}:L${27 + o}`, "　　下記の通り御注文申し上げますので、御用命賜りますようお願い申し上げます。", { fs: 9 });
  c(`B${28 + o}`, "№", { al: "r", bd: "b", color: "#0070c0" });
  c(`C${28 + o}:D${28 + o}`, escapeHtml(po.orderNo || ""), { al: "c", bd: "b" });
  c(`B${29 + o}:L${29 + o}`, "※納品書・請求書に上記№を記載してください。", { fs: 9 });
  // 本社・工場の住所
  c(`M${26 + o}:S${26 + o}`, addrLine(mark, "head", true));
  c(`N${27 + o}:S${27 + o}`, telLine("head"), { va: "t" });
  c(`M${28 + o}:R${28 + o}`, addrLine(mark, "factory", true));
  c(`N${29 + o}:R${29 + o}`, telLine("factory"), { va: "t" });

  // 明細の見出し
  const th = { al: "c", bd: "lrtb", fill: true };
  c(`A${H}`, "№", th);
  if (material) {
    c(`B${H}:D${H}`, "名称", th); c(`E${H}:I${H}`, "SIZE", th); c(`J${H}:K${H}`, "材質", th);
  } else {
    c(`B${H}:F${H}`, "図面№/部品名称", th); c(`G${H}:J${H}`, "表示型式", th); c(`K${H}`, "材質", th);
  }
  c(`L${H}:M${H}`, "数量", th); c(`N${H}`, "ﾒｰｶｰ", th); c(`O${H}:P${H}`, "手配先", th);
  c(`Q${H}`, "単価", th); c(`R${H}`, "金額", th); c(`S${H}`, "納期", th);

  // 明細
  let no = 0;
  lines.forEach((l, i) => {
    const r = L + i;
    const isNote = l && !l.qty && !l.unitPrice; // 「※ブランク材支給日…」のような注記だけの行
    if (l && !isNote) no++;
    const v = (k) => (l ? escapeHtml(l[k] ?? "") : "");
    const b = { bd: "lrtb" };
    c(`A${r}`, l && !isNote ? no : "", { fs: 8, al: "r", bd: "lrtb" });
    if (material) {
      c(`B${r}:D${r}`, v("name"), { ...b, fs: D });
      c(`E${r}:I${r}`, v("size"), { ...b, fs: D });
      c(`J${r}:K${r}`, v("material"), { ...b, fs: D, al: "c" });
    } else {
      c(`B${r}:F${r}`, v("name"), { ...b, fs: D });
      c(`G${r}:J${r}`, v("spec"), { ...b, fs: D });
      c(`K${r}`, v("material"), { ...b, fs: D, al: "c" });
    }
    c(`L${r}`, l && !isNote ? v("qty") : "", { ...b, fs: D, al: "r" });
    c(`M${r}`, l && !isNote ? escapeHtml(l.unit || "個") : "", { ...b, al: "c" });
    c(`N${r}`, v("maker"), { ...b, al: "c" });
    c(`O${r}:P${r}`, v("arranger"), { ...b, al: "c" });
    c(`Q${r}`, l && !isNote ? xlNum(l.unitPrice) : "", { ...b, al: "r" });
    // 単価が空なら金額も空(0と出さない)
    c(`R${r}`, l && !isNote && l.unitPrice !== "" && l.unitPrice != null ? xlNum((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)) : "", { ...b, al: "r" });
    c(`S${r}`, l ? escapeHtml(poDueText(l.due)) : "", { ...b, al: "r" });
  });
  c(`Q${E}`, "total", { al: "r", u: true });
  c(`R${E}`, poTotal(po) ? `¥${yen(poTotal(po))}` : "", { al: "r", u: true });
  c(`S${E}`, "（税抜）", { al: "l", u: true });

  // 納入先・備考欄
  const dest = po.deliverTo || OWN_DESTINATIONS[0];
  c(`A${B}:B${B}`, "納入先", { al: "c", fill: true, bd: "lt" });
  c(`C${B}:J${B}`, "", { bd: "t" });
  c(`A${B + 1}:A${B + 3}`, "", { bd: "lb" });
  c(`B${B + 1}`, "[宛先]", { al: "c" });
  c(`C${B + 1}:G${B + 1}`, escapeHtml(dest.name || ""));
  c(`H${B + 1}`, "[TEL]", { al: "c" });
  c(`I${B + 1}:J${B + 1}`, escapeHtml(dest.tel || ""));
  c(`B${B + 2}`, "[住所]", { al: "c" });
  c(`C${B + 2}:J${B + 2}`, escapeHtml(dest.address || ""));
  // 送状記載事項は注文書だけ(材料注文書では使わない。2026-11-10)
  c(`B${B + 3}:J${B + 3}`, material ? "" : `※送状記載事項：${escapeHtml(po.shipNote || "無")}`, { bd: "b" });
  c(`K${B}`, "備考欄", { al: "c", fill: true, bd: "lt" });
  c(`L${B}:S${B}`, "", { bd: "tr" });
  c(`K${B + 1}:S${B + 3}`, escapeHtml(po.remarks || "").replace(/\n/g, "<br>"), { va: "t", bd: "lrb", wrap: true });

  // ロゴと印欄は、Excelの図の位置(セルの上に置いてある)
  const top = (row, d) => [31.2, ...(material ? [31.2] : []), 24.6, 24.6, 24.6, 24.6, 24.6].slice(0, row - T).reduce((t, h) => t + h, 0) + d;
  const sealRow = 28 + o;
  const overlays = [
    material
      ? { x: 545.5, y: top(25, 14.5), w: 185.2, h: 37.4, html: LOGO_HTML }
      : { x: 542.8, y: 8.9, w: 184.3, h: 37.7, html: LOGO_HTML },
    { x: material ? 791.5 : 788.1, y: top(sealRow, material ? 9 : 3), w: 45.75, h: 40.6,
      html: `<div class="xl-seal">${sealImage ? `<img src="${sealImage}" alt="印">` : ""}</div>` },
  ];
  const rows = [];
  for (let r = T; r <= B + 3; r++) {
    rows.push(r === T || (material && r === T + 1) ? 31.2 : r < H ? 24.6 : r === H ? 28.2 : r <= E ? 27 : 16.2);
  }
  return `<div class="xl-page" data-page-margin="${material ? "54pt 10mm 8mm 50.4pt" : "72pt 10mm 8mm 54pt"}">${xlSheetHtml({
    cls: material ? "xl-material" : "xl-po",
    cols: [19.8, 34.2, 48.6, 48.6, 48.6, 48.6, 48.6, 48.6, 48.6, 48.6, 48.6, 33, 18.6, 48.6, 33, 18.6, 65.4, 65.4, 65.4],
    rows, base: T, sx: 0.8695, sy: 0.795, sf: 0.852, cells, overlays,
  })}</div>`;
}

/* 納品書・請求書(A4縦)。Excelの「納品書」シートと同じ。品物1つにExcelの2行を使う。
   行はExcel(16)より7行多い23行にして、A4の下の余白を小さくする(2026-11-18)。請求書は下に備考を入れるので18行。
   opt: { title, metaLabels:[2つ], meta:[2つ], customerName, greeting:[2行], dateHead, lines, sumLabels:[3つ], rowsCount, extraTop(html), remarks } */
function xlSlipHtml(opt) {
  const mark = opt.addrMark || "";
  const N = opt.rowsCount;
  const lines = opt.lines.slice();
  while (lines.length < N) lines.push(null);
  const subtotal = opt.lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const tax = Math.floor(subtotal * 0.1);
  const cells = [];
  const c = (ref, html, f) => cells.push([ref, html, f]);
  c("A1:E2", opt.title, { fs: 16, al: "c", u: true });
  c("L1", opt.metaLabels[0], { fs: 8, al: "r", u: true });
  c("M1", escapeHtml(opt.meta[0]), { fs: 8, al: "r", u: true });
  c("L2", opt.metaLabels[1], { fs: 8, al: "r", u: true });
  c("M2", escapeHtml(opt.meta[1]), { fs: 8, al: "r", u: true });
  c("A3:D3", escapeHtml(opt.customerName || ""), { fs: 12, al: "c", bd: "b" });
  c("E3", " 御中", { al: "c", bd: "b" });
  c("A5:I5", opt.greeting[0], { fs: 8 });
  c("A6:I6", opt.greeting[1] || "", { fs: 8 });
  if (opt.extraTop) c("A8:G10", opt.extraTop, { va: "b" });
  c("J7:M7", addrLine(mark, "head"), { fs: 8 });
  c("J8:M8", `　　${telLine("head")}`, { fs: 8, va: "t" });
  c("J9:M9", addrLine(mark, "factory"), { fs: 8 });
  c("J10:M10", `　　${telLine("factory")}`, { fs: 8, va: "t" });

  const th = { al: "c", bd: "lrtb", fill: true };
  c("A12", "№", th); c("B12", opt.dateHead, th); c("C12:G12", "名称", th); c("H12:I12", "数量", th);
  c("J12", "単価", th); c("K12", "金額", th); c("L12:M12", "備考欄", th);
  const b = { bd: "lrtb" };
  lines.forEach((l, i) => {
    const r = 13 + i * 2, r2 = r + 1;
    const v = (k) => (l ? escapeHtml(l[k] ?? "") : "");
    c(`A${r}:A${r2}`, l ? i + 1 : "", { ...b, fs: 8, al: "r" });
    c(`B${r}:B${r2}`, l ? escapeHtml(slashDate(l.date)) : "", { ...b, fs: 8, al: "c" });
    c(`C${r}:G${r2}`, v("name"), { ...b, al: "l" });
    c(`H${r}:H${r2}`, v("qty"), { ...b, al: "r" });
    c(`I${r}:I${r2}`, l ? escapeHtml(l.unit || "個") : "", { ...b, al: "c" });
    c(`J${r}:J${r2}`, l ? xlNum(l.unitPrice) : "", { ...b, fs: 9, al: "r" });
    c(`K${r}:K${r2}`, l ? xlNum((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)) : "", { ...b, fs: 9, al: "r" });
    c(`L${r}:M${r2}`, v("note"), { ...b, al: "l", va: "t", wrap: true });
  });
  const S = 13 + N * 2; // 合計の行
  const sumTh = { fs: 11, al: "c", bd: "lrtb", fill: true };
  const sumTd = { fs: 11, al: "r", bd: "lrtb" };
  c(`K${S}`, opt.sumLabels[0], sumTh); c(`L${S}:M${S}`, `¥${yen(subtotal)}`, sumTd);
  c(`K${S + 1}`, `${opt.sumLabels[1]} <span style="font-size:${Math.round(9 * 0.81 * 100) / 100}pt">(10％)</span>`, sumTh);
  c(`L${S + 1}:M${S + 1}`, `¥${yen(tax)}`, sumTd);
  c(`K${S + 2}`, opt.sumLabels[2], sumTh); c(`L${S + 2}:M${S + 2}`, `¥${yen(subtotal + tax)}`, sumTd);
  const rows = [16.2, 16.2, 24.6, 16.2, 16.2, 16.2, 16.2, 16.2, 16.2, 16.2, 16.2, 28.2];
  for (let i = 0; i < N * 2; i++) rows.push(13.2);
  rows.push(27, 27, 27);
  if (opt.remarks) {
    rows.push(16.2, 16.2, 32, 32);
    c(`A${S + 4}:C${S + 4}`, "備考・お振込先", { al: "c", fill: true, bd: "lt" });
    c(`D${S + 4}:M${S + 4}`, "", { bd: "tr" });
    c(`A${S + 5}:M${S + 6}`, escapeHtml(opt.remarks).replace(/\n/g, "<br>"), { va: "t", bd: "lrb", wrap: true });
  }
  return `<div class="xl-page" data-page-margin="54pt 10mm 8mm 50.4pt">${xlSheetHtml({
    cls: "xl-slip",
    cols: [17.4, 52.8, 48, 48, 48, 48, 48, 29.4, 16.8, 56.4, 73.8, 48, 60],
    rows, base: 1, sx: 0.828, sy: 0.764, sf: 0.81, cells,
    overlays: [{ x: 369.9, y: 66.75, w: 155.7, h: 31.3, html: LOGO_HTML }],
  })}</div>`;
}

// 納品書。dn: { customerName, issueDate, slipNo, addrMark, lines:[{date,name,qty,unit,unitPrice,note}] }
function deliveryNoteHtml(dn) {
  return xlSlipHtml({
    title: "納　品　書", metaLabels: ["発行日", "伝票№"], meta: [slashDate(dn.issueDate), dn.slipNo || ""],
    customerName: dn.customerName, addrMark: dn.addrMark,
    greeting: ["この度はお買い上げ頂き誠にありがとうございます。下記の通り納品致しました。", "これからもよろしくお願い申し上げます。"],
    dateHead: "日付", lines: dn.lines, sumLabels: ["合計", "消費税", "総合計"], rowsCount: 23,
  });
}

// 請求書(A4縦)。毎月・客先ごとに1枚で、その月に出荷した案件をまとめて載せる。納品書と同じ書式。
// inv: { customerName, issueDate, invoiceNo, periodLabel, remarks, addrMark, lines:[{date,name,qty,unit,unitPrice,note}] }
function invoiceHtml(inv) {
  const subtotal = inv.lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const total = subtotal + Math.floor(subtotal * 0.1);
  return xlSlipHtml({
    title: "請　求　書", metaLabels: ["請求日", "請求書№"], meta: [slashDate(inv.issueDate), inv.invoiceNo || ""],
    customerName: inv.customerName, addrMark: inv.addrMark,
    greeting: ["下記の通り、ご請求申し上げます。", inv.periodLabel ? `（${escapeHtml(inv.periodLabel)}）` : ""],
    extraTop: `<div class="xl-total-box"><span>ご請求金額（税込）</span><b>¥${yen(total)}</b></div>`,
    dateHead: "出荷日", lines: inv.lines, sumLabels: ["合計", "消費税", "ご請求金額"], rowsCount: 18,
    remarks: inv.remarks || "",
  });
}

/* ---------- 印刷 ----------
   画面に「印刷用の書類」を重ねて表示し、ブラウザの印刷を呼ぶ。
   印刷の画面で「送信先：PDFに保存」を選べばPDFになる。 */
function printDocument(html, orientation) {
  let area = document.getElementById("printArea");
  if (!area) {
    area = document.createElement("div");
    area.id = "printArea";
    document.body.appendChild(area);
  }
  let pageStyle = document.getElementById("printPageStyle");
  if (!pageStyle) {
    pageStyle = document.createElement("style");
    pageStyle.id = "printPageStyle";
    document.head.appendChild(pageStyle);
  }
  area.innerHTML = html;
  // 余白はExcelの印刷の余白に合わせる(書類の data-page-margin)
  const page = area.querySelector("[data-page-margin]");
  const margin = page ? page.dataset.pageMargin : "8mm";
  pageStyle.textContent = `@page { size: A4 ${orientation === "portrait" ? "portrait" : "landscape"}; margin: ${margin}; }`;
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  // ロゴ画像の読み込みを待ってから印刷する
  const imgs = Array.from(area.querySelectorAll("img"));
  Promise.all(imgs.map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))
    .then(() => window.print());
}
