/* ==========================================================
   未来栄株式会社 図面管理システム  図面(PDF)への書き込み
   ----------------------------------------------------------
   アップロード済みの図面に、白塗り(消しゴム)・ペン・矢印・線・四角・文字を書き込んで保存する。
     ・書き込みはページごとに「PDFの点」の座標で持つので、拡大・縮小しても位置がずれない
     ・保存するときは、書き込みだけを透明な画像にして各ページの上に重ねる
       (図面そのものは画像にしないので、画質が落ちず、ファイルもほとんど大きくならない)
     ・文字も画像として重ねるので、日本語の字体を用意しなくてよい
   使う部品：pdf.js(表示)、pdf-lib(保存)。読み込みは pdf-split.js の splitPartsReady を使う。
   ========================================================== */

const ANN_COLORS = [
  { value: "#d62828", label: "赤" },
  { value: "#1d4ed8", label: "青" },
  { value: "#111111", label: "黒" },
];
// 太さ(PDFの点)。白塗りは太め、文字は大きさ
const ANN_SIZES = {
  thin: { label: "細", pen: 1.2, white: 8, text: 10 },
  mid: { label: "中", pen: 2.5, white: 16, text: 16 },
  thick: { label: "太", pen: 5, white: 32, text: 26 },
};
const ANN_TOOLS = [
  { key: "whiteRect", icon: "▭", label: "白塗り(四角)", note: "ドラッグで囲んだ所を白で消す" },
  { key: "whitePen", icon: "🧽", label: "白塗り(なぞる)", note: "なぞった所を白で消す" },
  { key: "pen", icon: "✏️", label: "ペン" },
  { key: "arrow", icon: "↗", label: "矢印" },
  { key: "line", icon: "／", label: "線" },
  { key: "rect", icon: "□", label: "四角" },
  { key: "text", icon: "Ａ", label: "文字", note: "書きたい所をクリックして入力し、Enter" },
];
const ANN_SAVE_SCALE = 3; // 保存する書き込み画像の解像度(1点あたりの画素数)

function ensureAnnotateModal() {
  if (document.getElementById("annModal")) return;
  const el = document.createElement("div");
  el.className = "modal-overlay";
  el.id = "annModal";
  el.innerHTML = `
    <div class="modal-box ann-box">
      <div class="modal-head">
        <h3 id="annTitle">図面に書き込む</h3>
        <button type="button" class="modal-close" id="annClose" title="閉じる">&times;</button>
      </div>
      <div class="ann-toolbar">
        <div class="ann-group" id="annTools">
          ${ANN_TOOLS.map((t) => `<button type="button" class="ann-btn" data-tool="${t.key}" title="${t.note || t.label}"><span>${t.icon}</span>${t.label}</button>`).join("")}
        </div>
        <div class="ann-group">
          <span class="ann-label">色</span>
          ${ANN_COLORS.map((c) => `<button type="button" class="ann-color" data-color="${c.value}" title="${c.label}" style="--c:${c.value}"></button>`).join("")}
        </div>
        <div class="ann-group">
          <span class="ann-label">太さ</span>
          ${Object.entries(ANN_SIZES).map(([k, s]) => `<button type="button" class="ann-btn ann-size" data-size="${k}">${s.label}</button>`).join("")}
        </div>
        <div class="ann-group">
          <button type="button" class="ann-btn" id="annUndo" title="元に戻す">↶ 戻す</button>
          <button type="button" class="ann-btn" id="annRedo" title="やり直す">↷ やり直す</button>
        </div>
        <div class="ann-group">
          <button type="button" class="ann-btn" id="annZoomOut" title="縮小">－</button>
          <span class="ann-label" id="annZoomLabel">100%</span>
          <button type="button" class="ann-btn" id="annZoomIn" title="拡大">＋</button>
        </div>
      </div>
      <div class="ann-pages" id="annPages"></div>
      <div class="modal-foot">
        <span class="field-note" id="annNote">消したい所は「白塗り」で上から白く塗ります。保存すると、元の図面はこの内容に置き換わります。</span>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="annCancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="annSave">保存する</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
}

/* ---------- 書き込みを1つ描く(ctx は「1点＝s画素」に合わせて呼ぶ) ---------- */
function drawAnnotation(ctx, a) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const white = a.type === "whiteRect" || a.type === "whitePen";
  ctx.strokeStyle = white ? "#ffffff" : a.color;
  ctx.fillStyle = white ? "#ffffff" : a.color;
  ctx.lineWidth = a.width;
  if (a.type === "whiteRect") {
    ctx.fillRect(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
  } else if (a.type === "pen" || a.type === "whitePen") {
    ctx.beginPath();
    a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.01, a.points[0][1]);
    ctx.stroke();
  } else if (a.type === "line" || a.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
    if (a.type === "arrow") {
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = Math.max(8, a.width * 4);
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - head * Math.cos(ang - 0.45), a.y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(a.x2 - head * Math.cos(ang + 0.45), a.y2 - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    }
  } else if (a.type === "rect") {
    ctx.strokeRect(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
  } else if (a.type === "text") {
    ctx.font = `bold ${a.size}px "Yu Gothic", "Meiryo", sans-serif`;
    ctx.textBaseline = "top";
    String(a.text).split("\n").forEach((line, i) => ctx.fillText(line, a.x, a.y + i * a.size * 1.2));
  }
  ctx.restore();
}

/**
 * 図面に書き込む画面を開く。保存したら書き込み済みのPDF(File)を、キャンセルなら null を返す。
 */
async function openPdfAnnotator(blob, fileName) {
  ensureAnnotateModal();
  const modal = document.getElementById("annModal");
  const pagesEl = document.getElementById("annPages");
  document.getElementById("annTitle").textContent = `図面に書き込む — ${fileName}`;
  pagesEl.innerHTML = `<div class="empty-state">図面を読み込んでいます…</div>`;
  modal.classList.add("open");

  await splitPartsReady();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

  const state = { tool: "whiteRect", color: ANN_COLORS[0].value, size: "mid", zoom: 1 };
  const pages = [];   // { page, view(倍率1), wrap, base, over, items: [] }
  const history = []; // { p, item }
  const redoStack = [];
  let fitScale = 1;   // 画面の幅に合わせる倍率(zoom=100%のとき)

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    pages.push({ page, view: page.getViewport({ scale: 1 }), items: [] });
  }
  const maxW = Math.max(...pages.map((p) => p.view.width));
  fitScale = Math.max(0.3, (pagesEl.clientWidth - 40) / maxW);

  function redraw(p, temp) {
    const s = fitScale * state.zoom;
    const dpr = window.devicePixelRatio || 1;
    const ctx = p.over.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.over.width, p.over.height);
    ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
    p.items.forEach((a) => drawAnnotation(ctx, a));
    if (temp) drawAnnotation(ctx, temp);
  }

  async function renderAll() {
    const s = fitScale * state.zoom;
    const dpr = window.devicePixelRatio || 1;
    document.getElementById("annZoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
    pagesEl.innerHTML = "";
    for (const [idx, p] of pages.entries()) {
      const w = p.view.width * s, h = p.view.height * s;
      p.wrap = document.createElement("div");
      p.wrap.className = "ann-page";
      p.wrap.style.width = `${w}px`;
      p.wrap.style.height = `${h}px`;
      p.base = document.createElement("canvas");
      p.over = document.createElement("canvas");
      p.over.className = "ann-over";
      [p.base, p.over].forEach((c) => {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        p.wrap.appendChild(c);
      });
      p.over.dataset.page = idx;
      pagesEl.appendChild(p.wrap);
      await p.page.render({ canvasContext: p.base.getContext("2d"), viewport: p.page.getViewport({ scale: s * dpr }) }).promise;
      redraw(p);
    }
    syncCursor();
  }

  function syncToolbar() {
    document.querySelectorAll("#annTools [data-tool]").forEach((b) => b.classList.toggle("is-on", b.dataset.tool === state.tool));
    document.querySelectorAll("#annModal [data-color]").forEach((b) => b.classList.toggle("is-on", b.dataset.color === state.color));
    document.querySelectorAll("#annModal [data-size]").forEach((b) => b.classList.toggle("is-on", b.dataset.size === state.size));
    document.getElementById("annUndo").disabled = !history.length;
    document.getElementById("annRedo").disabled = !redoStack.length;
    syncCursor();
  }

  function syncCursor() {
    pages.forEach((p) => p.over && (p.over.style.cursor = state.tool === "text" ? "text" : "crosshair"));
  }

  function commit(p, item) {
    p.items.push(item);
    history.push({ p, item });
    redoStack.length = 0;
    redraw(p);
    syncToolbar();
  }

  // 画面の位置 → PDFの点
  function pointOf(p, ev) {
    const r = p.over.getBoundingClientRect();
    const s = fitScale * state.zoom;
    return [(ev.clientX - r.left) / s, (ev.clientY - r.top) / s];
  }

  /* ---------- 描く ---------- */
  let drag = null; // { p, item }
  let textBox = null;

  function closeTextBox(save) {
    if (!textBox) return;
    const { input, p, x, y, size, color } = textBox;
    textBox = null;
    const text = input.value.trim();
    input.remove();
    if (save && text) commit(p, { type: "text", x, y, text, size, color });
  }

  function openTextBox(p, x, y) {
    closeTextBox(true);
    const s = fitScale * state.zoom;
    const size = ANN_SIZES[state.size].text;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ann-text-input";
    input.style.left = `${x * s}px`;
    input.style.top = `${y * s}px`;
    input.style.fontSize = `${size * s}px`;
    input.style.color = state.color;
    input.placeholder = "文字を入力して Enter";
    p.wrap.appendChild(input);
    textBox = { input, p, x, y, size, color: state.color };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); closeTextBox(true); }
      if (ev.key === "Escape") { ev.preventDefault(); closeTextBox(false); }
    });
    input.addEventListener("blur", () => setTimeout(() => closeTextBox(true), 0));
    setTimeout(() => input.focus(), 0);
  }

  pagesEl.onpointerdown = (ev) => {
    const canvas = ev.target.closest(".ann-over");
    if (!canvas) return;
    const p = pages[Number(canvas.dataset.page)];
    const [x, y] = pointOf(p, ev);
    ev.preventDefault();
    if (state.tool === "text") return openTextBox(p, x, y);
    closeTextBox(true);
    const sz = ANN_SIZES[state.size];
    const t = state.tool;
    const item = t === "pen" || t === "whitePen"
      ? { type: t, points: [[x, y]], width: t === "pen" ? sz.pen : sz.white, color: state.color }
      : { type: t, x1: x, y1: y, x2: x, y2: y, width: sz.pen, color: state.color };
    drag = { p, item };
    try {
      canvas.setPointerCapture(ev.pointerId); // 図面の外までドラッグしても描き続ける
    } catch (e) { /* 取れない環境では無くても描ける */ }
  };
  pagesEl.onpointermove = (ev) => {
    if (!drag) return;
    const [x, y] = pointOf(drag.p, ev);
    if (drag.item.points) drag.item.points.push([x, y]);
    else Object.assign(drag.item, { x2: x, y2: y });
    redraw(drag.p, drag.item);
  };
  pagesEl.onpointerup = () => {
    if (!drag) return;
    const { p, item } = drag;
    drag = null;
    const tiny = !item.points && Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 2;
    if (tiny) return redraw(p); // クリックしただけのときは描かない
    commit(p, item);
  };

  /* ---------- 道具・色・太さ・戻す・拡大 ---------- */
  const toolbar = modal.querySelector(".ann-toolbar");
  toolbar.onclick = async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) state.tool = b.dataset.tool;
    if (b.dataset.color) state.color = b.dataset.color;
    if (b.dataset.size) state.size = b.dataset.size;
    if (b.id === "annUndo" && history.length) {
      const h = history.pop();
      h.p.items.splice(h.p.items.lastIndexOf(h.item), 1);
      redoStack.push(h);
      redraw(h.p);
    }
    if (b.id === "annRedo" && redoStack.length) {
      const h = redoStack.pop();
      h.p.items.push(h.item);
      history.push(h);
      redraw(h.p);
    }
    if (b.id === "annZoomIn" || b.id === "annZoomOut") {
      closeTextBox(true);
      const steps = [0.5, 0.75, 1, 1.5, 2, 3];
      const i = steps.indexOf(state.zoom);
      state.zoom = steps[Math.max(0, Math.min(steps.length - 1, i + (b.id === "annZoomIn" ? 1 : -1)))];
      await renderAll();
    }
    syncToolbar();
  };

  /* ---------- 保存：書き込みを透明な画像にして各ページに重ねる ---------- */
  async function buildPdf() {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const docPages = doc.getPages();
    for (const [i, p] of pages.entries()) {
      if (!p.items.length) continue;
      const W = p.view.width, H = p.view.height;
      const c = document.createElement("canvas");
      c.width = Math.round(W * ANN_SAVE_SCALE);
      c.height = Math.round(H * ANN_SAVE_SCALE);
      const ctx = c.getContext("2d");
      ctx.setTransform(ANN_SAVE_SCALE, 0, 0, ANN_SAVE_SCALE, 0, 0);
      p.items.forEach((a) => drawAnnotation(ctx, a));
      const png = await doc.embedPng(c.toDataURL("image/png"));
      // 画面の左下・右下がPDFのどこに当たるかから、置く位置と向きを決める(回転したページにも対応)
      const [ox, oy] = p.view.convertToPdfPoint(0, H);
      const [ax, ay] = p.view.convertToPdfPoint(W, H);
      const angle = Math.atan2(ay - oy, ax - ox) * 180 / Math.PI;
      docPages[i].drawImage(png, { x: ox, y: oy, width: W, height: H, rotate: PDFLib.degrees(angle) });
    }
    const out = await doc.save();
    return new File([out], fileName, { type: "application/pdf" });
  }

  syncToolbar();
  await renderAll();

  return new Promise((resolve) => {
    const close = (result) => {
      closeTextBox(false);
      modal.classList.remove("open");
      pagesEl.innerHTML = "";
      resolve(result);
    };
    const hasEdits = () => pages.some((p) => p.items.length);
    const cancel = () => {
      if (hasEdits() && !confirm("書き込んだ内容を保存せずに閉じますか？")) return;
      close(null);
    };
    document.getElementById("annCancel").onclick = cancel;
    document.getElementById("annClose").onclick = cancel;
    document.getElementById("annSave").onclick = async () => {
      closeTextBox(true);
      if (!hasEdits()) return toast("まだ何も書き込まれていません。");
      const btn = document.getElementById("annSave");
      btn.disabled = true;
      btn.textContent = "保存の準備中…";
      try {
        close(await buildPdf());
      } catch (err) {
        console.error("書き込みを保存できませんでした", err);
        toast("保存できませんでした。" + (err.message || ""));
      } finally {
        btn.disabled = false;
        btn.textContent = "保存する";
      }
    };
  });
}
