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

// これまでの書類に出てきた外注先・材料屋。注文書の宛先と、直送するときの納入先の候補。
// short はExcelの「メーカー」「手配先」欄に入れていた略称。
const DEFAULT_VENDORS = [
  { name: "㈱テルミック", short: "テル", tel: "092-791-4200", address: "〒810-0041　福岡県福岡市中央区大名2-2-13" },
  { name: "㈱タツミ精機", short: "タツミ", tel: "0265-25-5299", address: "〒395-0155　長野県飯田市三日市場1777-7" },
  { name: "㈱丸菱電子", short: "丸菱", tel: "0258-28-2222", address: "〒940-2022　新潟県長岡市鉄工町1丁目2番10号" },
  { name: "㈱城南キー", short: "城南", tel: "", address: "" },
  { name: "㈱寿機化", short: "寿", tel: "06-6789-1653", address: "〒577-0026　東大阪市新家東町1-23" },
  { name: "㈱金太", short: "金太", tel: "", address: "" },
  { name: "㈱伸栄商会", short: "伸栄", tel: "076-266-8383", address: "〒920-0333　石川県金沢市無量寺2-62" },
];

// 納品書の宛名(客先グループ → 正式名)
const CUSTOMER_FORMAL_NAMES = {
  "CAM'S": "株式会社CAM'S",
  "伸栄": "株式会社伸栄商會",
  "DID": "株式会社大同テクノ",
};

const PO_KINDS = { order: "注文書", material: "材料注文書" };

/* ---------- 外注先 ---------- */

// 既定の外注先＋これまでの注文書に出てきた外注先(新しい情報を優先)
function knownVendors(pos) {
  const map = new Map(DEFAULT_VENDORS.map((v) => [v.name, { ...v }]));
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
   Firestore の settings/seal に画像(dataURL)で保存する。 */
async function loadSealImage() {
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc("seal").get();
    return doc.exists ? doc.data().image || "" : "";
  } catch (err) {
    console.warn("印影を読み込めませんでした", err);
    return "";
  }
}

async function saveSealImage(dataUrl) {
  await db.collection(SETTINGS_COLLECTION).doc("seal").set({
    image: dataUrl,
    updatedBy: auth.currentUser ? auth.currentUser.email : "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
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

function companyBlockHtml(sealImage) {
  return `
    <div class="doc-company">
      <img class="doc-logo" src="img/logo.jpg" alt="未来栄株式会社">
      <div class="doc-addr">
        <div>□ ${COMPANY.head.label}　${COMPANY.head.zip} ${COMPANY.head.address}</div>
        <div class="doc-tel">TEL ${COMPANY.head.tel}　FAX ： ${COMPANY.head.fax}</div>
        <div>□ ${COMPANY.factory.label}　${COMPANY.factory.zip} ${COMPANY.factory.address}</div>
        <div class="doc-tel">TEL ${COMPANY.factory.tel}　FAX ： ${COMPANY.factory.fax}</div>
      </div>
      ${sealImage !== undefined ? `<div class="doc-seal">${sealImage ? `<img src="${sealImage}" alt="印">` : ""}</div>` : ""}
    </div>`;
}

// 注文書・材料注文書(A4横)
function purchaseOrderHtml(po, sealImage) {
  const material = po.kind === "material";
  const MIN_ROWS = 11;
  const lines = (po.lines || []).slice();
  while (lines.length < MIN_ROWS) lines.push(null);
  let no = 0;
  const rowsHtml = lines.map((l) => {
    if (!l) return `<tr>${"<td></td>".repeat(material ? 11 : 11)}</tr>`;
    const isNote = !l.qty && !l.unitPrice; // 「※ブランク材支給日…」のような注記だけの行
    if (!isNote) no++;
    const amount = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    return material
      ? `<tr>
          <td class="c">${isNote ? "" : no}</td><td>${escapeHtml(l.name || "")}</td><td>${escapeHtml(l.size || "")}</td>
          <td class="c">${escapeHtml(l.material || "")}</td><td class="r">${isNote ? "" : escapeHtml(l.qty)}</td><td class="c">${isNote ? "" : escapeHtml(l.unit || "個")}</td>
          <td class="c">${escapeHtml(l.maker || "")}</td><td class="c">${escapeHtml(l.arranger || "")}</td>
          <td class="r">${isNote ? "" : yen(l.unitPrice)}</td><td class="r">${isNote ? "" : yen(amount)}</td><td class="c">${escapeHtml(l.due || "")}</td></tr>`
      : `<tr>
          <td class="c">${isNote ? "" : no}</td><td>${escapeHtml(l.name || "")}</td><td>${escapeHtml(l.spec || "")}</td>
          <td class="c">${escapeHtml(l.material || "")}</td><td class="r">${isNote ? "" : escapeHtml(l.qty)}</td><td class="c">${isNote ? "" : escapeHtml(l.unit || "個")}</td>
          <td class="c">${escapeHtml(l.maker || "")}</td><td class="c">${escapeHtml(l.arranger || "")}</td>
          <td class="r">${isNote ? "" : yen(l.unitPrice)}</td><td class="r">${isNote ? "" : yen(amount)}</td><td class="c">${escapeHtml(l.due || "")}</td></tr>`;
  }).join("");
  const dest = po.deliverTo || OWN_DESTINATIONS[0];
  return `
    <div class="doc-sheet doc-landscape">
      <div class="doc-head">
        <div class="doc-head-left">
          <div class="doc-title">${material ? "材 料 注 文 書" : "注　文　書"}</div>
          <div class="doc-to"><span class="doc-to-name">${escapeHtml(po.vendor || "")}</span><span>御中</span></div>
          <div class="doc-to"><span class="doc-to-name">${escapeHtml(po.vendorPerson || "")}</span><span>様</span></div>
          <div class="doc-small">下記の通り御注文申し上げますので、御用命賜りますようお願い申し上げます。</div>
          <div class="doc-no"><span>№</span>${escapeHtml(po.orderNo || "")}</div>
          <div class="doc-small">※納品書・請求書に上記№を記載してください。</div>
        </div>
        <div class="doc-head-right">
          <div class="doc-date">${escapeHtml(jpDate(po.issueDate))}</div>
          ${companyBlockHtml(sealImage)}
        </div>
      </div>
      <table class="doc-table">
        <colgroup>${material
          ? `<col style="width:3%"><col style="width:16%"><col style="width:20%"><col style="width:8%"><col style="width:5%"><col style="width:3%"><col style="width:7%"><col style="width:7%"><col style="width:9%"><col style="width:10%"><col style="width:10%">`
          : `<col style="width:3%"><col style="width:24%"><col style="width:20%"><col style="width:6%"><col style="width:5%"><col style="width:3%"><col style="width:6%"><col style="width:6%"><col style="width:8%"><col style="width:8%"><col style="width:11%">`}</colgroup>
        <thead><tr>
          <th>№</th><th>${material ? "名称" : "図面№/部品名称"}</th><th>${material ? "SIZE" : "表示型式"}</th><th>材質</th>
          <th colspan="2">数量</th><th>ﾒｰｶｰ</th><th>手配先</th><th>単価</th><th>金額</th><th>納期</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="doc-total"><span>total</span><b>¥${yen(poTotal(po))}</b><span>（税抜）</span></div>
      <div class="doc-bottom">
        <div class="doc-box">
          <div class="doc-box-title">納入先</div>
          <div>[宛先] ${escapeHtml(dest.name || "")}　　　　[TEL] ${escapeHtml(dest.tel || "")}</div>
          <div>[住所] ${escapeHtml(dest.address || "")}</div>
          <div>※送状記載事項：${escapeHtml(po.shipNote || "無")}</div>
        </div>
        <div class="doc-box">
          <div class="doc-box-title">備考欄</div>
          <div class="doc-remarks">${escapeHtml(po.remarks || "")}</div>
        </div>
      </div>
    </div>`;
}

// 納品書(A4縦)。dn: { customerName, issueDate, slipNo, lines:[{date,name,qty,unit,unitPrice,note}] }
function deliveryNoteHtml(dn) {
  const MIN_ROWS = 16;
  const lines = dn.lines.slice();
  while (lines.length < MIN_ROWS) lines.push(null);
  const subtotal = dn.lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const tax = Math.floor(subtotal * 0.1);
  return `
    <div class="doc-sheet doc-portrait">
      <div class="doc-head">
        <div class="doc-head-left">
          <div class="doc-title">納　品　書</div>
          <div class="doc-to"><span class="doc-to-name">${escapeHtml(dn.customerName || "")}</span><span>御中</span></div>
          <div class="doc-small" style="margin-top:14px;">この度はお買い上げ頂き誠にありがとうございます。下記の通り納品致しました。<br>これからもよろしくお願い申し上げます。</div>
        </div>
        <div class="doc-head-right">
          <table class="doc-meta">
            <tr><th>発行日</th><td>${escapeHtml(slashDate(dn.issueDate))}</td></tr>
            <tr><th>伝票№</th><td>${escapeHtml(dn.slipNo || "")}</td></tr>
          </table>
          ${companyBlockHtml()}
        </div>
      </div>
      <table class="doc-table">
        <colgroup><col style="width:4%"><col style="width:11%"><col style="width:36%"><col style="width:6%"><col style="width:4%"><col style="width:10%"><col style="width:11%"><col style="width:18%"></colgroup>
        <thead><tr><th>№</th><th>日付</th><th>名称</th><th colspan="2">数量</th><th>単価</th><th>金額</th><th>備考欄</th></tr></thead>
        <tbody>${lines.map((l, i) => l
          ? `<tr><td class="c">${i + 1}</td><td class="c">${escapeHtml(slashDate(l.date))}</td><td>${escapeHtml(l.name)}</td>
               <td class="r">${escapeHtml(l.qty)}</td><td class="c">${escapeHtml(l.unit || "個")}</td><td class="r">${yen(l.unitPrice)}</td>
               <td class="r">${yen((Number(l.qty) || 0) * (Number(l.unitPrice) || 0))}</td><td>${escapeHtml(l.note || "")}</td></tr>`
          : `<tr>${"<td></td>".repeat(8)}</tr>`).join("")}</tbody>
      </table>
      <table class="doc-sum">
        <tr><th>合計</th><td>¥${yen(subtotal)}</td></tr>
        <tr><th>消費税 (10%)</th><td>¥${yen(tax)}</td></tr>
        <tr><th>総合計</th><td>¥${yen(subtotal + tax)}</td></tr>
      </table>
    </div>`;
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
  pageStyle.textContent = `@page { size: A4 ${orientation === "portrait" ? "portrait" : "landscape"}; margin: 8mm; }`;
  area.innerHTML = html;
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
