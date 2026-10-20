/* ==========================================================
   未来栄株式会社 図面管理システム  1つのPDFを書類ごとに分ける
   ----------------------------------------------------------
   客先から「注文書＋図面」が1つのPDFで届いたときに、アップロードの前に分ける。
   ページの小さい画像を並べ、ページごとに書類の種類を選んでもらう。
     ・「図面」のページは1ページずつ別のファイルにする(図面は図番ごとに見たいので)
     ・それ以外は、同じ種類が続くページを1つのファイルにまとめる
     ・「保存しない」を選んだページは捨てる
   使う部品(CDN、分けるときだけ読み込む)：pdf.js(小さい画像)、pdf-lib(切り出し)
   ========================================================== */

const SPLIT_PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";
const SPLIT_PDFLIB = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
const SPLIT_SKIP = "__skip__";

function loadScriptOnce(src) {
  if (document.querySelector(`script[data-src="${src}"]`)) {
    return document.querySelector(`script[data-src="${src}"]`)._ready;
  }
  const s = document.createElement("script");
  s.src = src;
  s.dataset.src = src;
  s._ready = new Promise((resolve, reject) => {
    s.onload = resolve;
    s.onerror = () => reject(new Error("PDFの部品を読み込めませんでした。インターネット接続を確認してください。"));
  });
  document.head.appendChild(s);
  return s._ready;
}

async function splitPartsReady() {
  if (!window.pdfjsLib) await loadScriptOnce(SPLIT_PDFJS + "pdf.min.js");
  if (!window.PDFLib) await loadScriptOnce(SPLIT_PDFLIB);
  pdfjsLib.GlobalWorkerOptions.workerSrc = SPLIT_PDFJS + "pdf.worker.min.js";
}

function isPdfFile(file) {
  return file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
}

function ensureSplitModal() {
  if (document.getElementById("splitModal")) return;
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "splitModal";
  el.innerHTML = `
    <div class="modal-box modal-box-split">
      <div class="modal-head">
        <h3 id="splitTitle">PDFを書類ごとに分ける</h3>
        <button type="button" class="modal-close" id="splitClose" title="閉じる">&times;</button>
      </div>
      <div class="modal-body">
        <div class="field-note" style="margin-bottom:10px;">ページごとに書類の種類を選んでください。
          「図面」は1ページずつ別の書類に、それ以外は同じ種類が続くページを1つにまとめます。要らないページは「保存しない」を選びます。</div>
        <div id="splitPages" class="split-pages"></div>
      </div>
      <div class="modal-foot">
        <span id="splitSummary" class="field-note"></span>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="splitCancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="splitOk">この内容で分ける</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
}

/**
 * PDFを分ける画面を開く。分け終わったら [{ file, docType }] を返す(キャンセルなら null)。
 * types: 選べる書類の種類
 */
async function openPdfSplitter(file, types) {
  ensureSplitModal();
  const modal = document.getElementById("splitModal");
  const area = document.getElementById("splitPages");
  document.getElementById("splitTitle").textContent = `PDFを書類ごとに分ける — ${file.name}`;
  area.innerHTML = `<div class="empty-state">ページを読み込んでいます…</div>`;
  modal.classList.add("open");

  await splitPartsReady();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const n = pdf.numPages;
  const firstType = types.includes("客先からの注文書") ? "客先からの注文書" : types[0];
  const restType = types.includes("図面") ? "図面" : types[0];
  area.innerHTML = Array.from({ length: n }, (_, i) => `
    <div class="split-page">
      <div class="split-thumb"><canvas data-page="${i}"></canvas></div>
      <div class="split-label">${i + 1}ページ</div>
      <select data-split="${i}">
        ${types.map((t) => `<option value="${t}" ${t === (i === 0 ? firstType : restType) ? "selected" : ""}>${t}</option>`).join("")}
        <option value="${SPLIT_SKIP}">保存しない</option>
      </select>
    </div>`).join("");

  // 小さい画像(1ページずつ描く)
  for (let i = 0; i < n; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 180 / Math.max(vp.width, vp.height);
    const view = page.getViewport({ scale });
    const canvas = area.querySelector(`canvas[data-page="${i}"]`);
    canvas.width = view.width;
    canvas.height = view.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: view }).promise;
  }

  const groupsOf = () => {
    const sel = Array.from(area.querySelectorAll("[data-split]")).map((s) => s.value);
    const groups = [];
    sel.forEach((type, i) => {
      if (type === SPLIT_SKIP) return;
      const last = groups[groups.length - 1];
      if (type !== "図面" && last && last.type === type && last.pages[last.pages.length - 1] === i - 1) last.pages.push(i);
      else groups.push({ type, pages: [i] });
    });
    return groups;
  };
  const showSummary = () => {
    const g = groupsOf();
    document.getElementById("splitSummary").textContent = `${g.length}つの書類に分けます`;
  };
  area.onchange = showSummary;
  showSummary();

  return new Promise((resolve) => {
    const close = (result) => {
      modal.classList.remove("open");
      area.innerHTML = "";
      resolve(result);
    };
    document.getElementById("splitCancel").onclick = () => close(null);
    document.getElementById("splitClose").onclick = () => close(null);
    document.getElementById("splitOk").onclick = async () => {
      const groups = groupsOf();
      if (!groups.length) return toast("保存するページを1つ以上選んでください。");
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const base = file.name.replace(/\.pdf$/i, "");
      const counter = {};
      const parts = [];
      for (const g of groups) {
        const out = await PDFLib.PDFDocument.create();
        (await out.copyPages(src, g.pages)).forEach((p) => out.addPage(p));
        const data = await out.save();
        counter[g.type] = (counter[g.type] || 0) + 1;
        const pagesText = g.pages.length > 1 ? `p${g.pages[0] + 1}-${g.pages[g.pages.length - 1] + 1}` : `p${g.pages[0] + 1}`;
        parts.push({
          docType: g.type,
          file: new File([data], `${base}_${g.type}_${pagesText}.pdf`, { type: "application/pdf" }),
        });
      }
      close(parts);
    };
  });
}
