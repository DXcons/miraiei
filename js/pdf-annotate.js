/* ==========================================================
   未来栄株式会社 図面管理システム  図面(PDF)への書き込み
   ----------------------------------------------------------
   アップロード済みの図面に、白塗り(消しゴム)・ペン・矢印・線・四角・文字を書き込んで保存する。
     ・書き込みはページごとに「PDFの点」の座標で持つので、拡大・縮小しても位置がずれない
     ・書き込んだあとも「選んで動かす」で選び、ドラッグで動かしたり消したりできる
     ・ページは90度ずつ回せる。書き込みの座標は回す前の向きで持ち、画面に出すときだけ回す
       (回しても書き込みは図面にくっついたまま一緒に回る)
     ・保存するときは、書き込みだけを透明な画像にして各ページの上に重ね、回した分はページの向きとして保存する
       (図面そのものは画像にしないので、画質が落ちず、ファイルもほとんど大きくならない)
     ・文字も画像として重ねるので、日本語の字体を用意しなくてよい
     ・ページは画面に見えてきたものから順に描く(ページ数が多い・大きい図面でも早く開く)
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
  { key: "select", icon: "✋", label: "選んで動かす", note: "書き込みをクリックで選び、ドラッグで動かす。Deleteキーか「消す」で消せる" },
  { key: "whiteRect", icon: "▭", label: "白塗り(四角)", note: "ドラッグで囲んだ所を白で消す" },
  { key: "whitePen", icon: "🧽", label: "白塗り(なぞる)", note: "なぞった所を白で消す" },
  { key: "pen", icon: "✏️", label: "ペン" },
  { key: "arrow", icon: "↗", label: "矢印" },
  { key: "line", icon: "／", label: "線" },
  { key: "rect", icon: "□", label: "四角" },
  { key: "text", icon: "Ａ", label: "文字", note: "書きたい所をクリックして入力し、Enter" },
];
const ANN_SAVE_SCALE = 3; // 保存する書き込み画像の解像度(1点あたりの画素数)
// 画面に出す1ページの画素数の上限。大きな図面を拡大したときに、描くのが遅くなったり真っ白になったりしないように
const ANN_MAX_CANVAS_PX = 16000000;
const ANN_HIT_PX = 6; // 「選んで動かす」でクリックが当たったとみなす幅(画面の画素)

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
          <button type="button" class="ann-btn" id="annDelete" title="選んだ書き込みを消す(Deleteキーでも消せる)">🗑 消す</button>
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
        <span class="field-note" id="annNote">消したい所は「白塗り」で上から白く塗ります。書いた物は「選んで動かす」で動かせます。保存すると、元の図面はこの内容に置き換わります。</span>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="annCancel">キャンセル</button>
          <button type="button" class="btn btn-primary" id="annSave">保存する</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
}

/* ---------- 書き込みを1つ描く(ctx は「1点＝s画素」に合わせて呼ぶ) ---------- */
function annFont(size) {
  return `bold ${size}px "Yu Gothic", "Meiryo", sans-serif`;
}

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
    // 文字は書いたときの画面の向きで横書きになるよう、ページを回した分だけ逆に回して描く
    ctx.translate(a.x, a.y);
    if (a.rot) ctx.rotate((-a.rot * Math.PI) / 180);
    ctx.font = annFont(a.size);
    ctx.textBaseline = "top";
    String(a.text).split("\n").forEach((line, i) => ctx.fillText(line, 0, i * a.size * 1.2));
  }
  ctx.restore();
}

/* ---------- 書き込みの当たり判定・枠・移動(座標はすべて回す前の向きのPDFの点) ---------- */
let annMeasureCtx = null;
function annTextSize(a) {
  annMeasureCtx = annMeasureCtx || document.createElement("canvas").getContext("2d");
  annMeasureCtx.font = annFont(a.size);
  const lines = String(a.text).split("\n");
  return { w: Math.max(...lines.map((l) => annMeasureCtx.measureText(l).width)), h: lines.length * a.size * 1.2 };
}

// 文字の座標(文字の左上が原点、文字の向きに沿った軸)に直す
function annTextLocal(a, x, y) {
  const t = ((a.rot || 0) * Math.PI) / 180;
  const dx = x - a.x, dy = y - a.y;
  return [dx * Math.cos(t) - dy * Math.sin(t), dx * Math.sin(t) + dy * Math.cos(t)];
}

// 文字以外の外枠 [左, 上, 右, 下]
function annBox(a) {
  const xs = a.points ? a.points.map((q) => q[0]) : [a.x1, a.x2];
  const ys = a.points ? a.points.map((q) => q[1]) : [a.y1, a.y2];
  const pad = a.type === "whiteRect" ? 0 : a.width / 2;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

function annDistToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function annHit(a, x, y, tol) {
  if (a.type === "text") {
    const [u, v] = annTextLocal(a, x, y);
    const { w, h } = annTextSize(a);
    return u >= -tol && v >= -tol && u <= w + tol && v <= h + tol;
  }
  const r = tol + (a.width || 0) / 2;
  if (a.type === "whiteRect") {
    const [l, t, rr, b] = annBox(a);
    return x >= l - tol && x <= rr + tol && y >= t - tol && y <= b + tol;
  }
  if (a.type === "rect") {
    // 枠線の近くだけ当たりにする(中に書いた物を選べるように)
    const l = Math.min(a.x1, a.x2), t = Math.min(a.y1, a.y2), rr = Math.max(a.x1, a.x2), b = Math.max(a.y1, a.y2);
    const outer = x >= l - r && x <= rr + r && y >= t - r && y <= b + r;
    const inner = x > l + r && x < rr - r && y > t + r && y < b - r;
    return outer && !inner;
  }
  if (a.points) {
    if (a.points.length === 1) return Math.hypot(x - a.points[0][0], y - a.points[0][1]) <= r;
    for (let i = 1; i < a.points.length; i++) {
      const [x1, y1] = a.points[i - 1], [x2, y2] = a.points[i];
      if (annDistToSeg(x, y, x1, y1, x2, y2) <= r) return true;
    }
    return false;
  }
  return annDistToSeg(x, y, a.x1, a.y1, a.x2, a.y2) <= r;
}

function annMove(a, dx, dy) {
  if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
  else if (a.type === "text") { a.x += dx; a.y += dy; }
  else { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
}

// 選んだ書き込みのまわりに点線の枠を描く(s は画面の倍率。線の太さを画面上で一定にするため)
function drawAnnSelection(ctx, a, s) {
  ctx.save();
  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 1.5 / s;
  ctx.setLineDash([6 / s, 4 / s]);
  const m = 4 / s;
  if (a.type === "text") {
    const { w, h } = annTextSize(a);
    ctx.translate(a.x, a.y);
    if (a.rot) ctx.rotate((-a.rot * Math.PI) / 180);
    ctx.strokeRect(-m, -m, w + 2 * m, h + 2 * m);
  } else {
    const [l, t, r, b] = annBox(a);
    ctx.strokeRect(l - m, t - m, r - l + 2 * m, b - t + 2 * m);
  }
  ctx.restore();
}

/**
 * 図面に書き込む画面を開く。保存したら書き込み済みのPDF(File)を、キャンセルなら null を返す。
 * source には Blob か、Blob を返す Promise を渡せる(Promise なら、ダウンロード中から画面を開いて待つ)。
 */
async function openPdfAnnotator(source, fileName) {
  ensureAnnotateModal();
  const modal = document.getElementById("annModal");
  const pagesEl = document.getElementById("annPages");
  document.getElementById("annTitle").textContent = `図面に書き込む — ${fileName}`;
  pagesEl.innerHTML = `<div class="empty-state">図面を読み込んでいます…</div>`;
  modal.classList.add("open");

  let bytes, pdf;
  try {
    // 図面のダウンロードとPDF部品の読み込みを同時に進める
    const [blob] = await Promise.all([source, splitPartsReady()]);
    bytes = new Uint8Array(await blob.arrayBuffer());
    pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    modal.classList.remove("open");
    pagesEl.innerHTML = "";
    throw err;
  }
  const U = pdfjsLib.Util;

  const state = { tool: "whiteRect", color: ANN_COLORS[0].value, size: "mid", zoom: 1 };
  // { page, view(倍率1・回す前), rot(回した角度), disp(回したあとの向き), toDisp/toBase(座標の変換), fit, wrap, base, over, items: [] }
  const pages = [];
  const history = []; // { type: "add"|"delete"|"move"|"rotate", p, ... }
  const redoStack = [];
  let selected = null; // { p, item }
  const availW = Math.max(200, pagesEl.clientWidth - 40);

  // ページの向きを決め、回す前の座標 ⇔ 画面の向きの座標 の変換を作り直す
  function setRot(p, rot) {
    p.rot = ((rot % 360) + 360) % 360;
    p.disp = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + p.rot) % 360 });
    p.toDisp = U.transform(p.disp.transform, U.inverseTransform(p.view.transform));
    p.toBase = U.inverseTransform(p.toDisp);
    p.fit = Math.max(0.3, availW / p.disp.width); // 100%のときはページの幅を画面の幅に合わせる
  }

  const loaded = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
  loaded.forEach((page) => {
    const p = { page, view: page.getViewport({ scale: 1 }), items: [] };
    setRot(p, 0);
    pages.push(p);
  });

  const scaleOf = (p) => p.fit * state.zoom;

  function redraw(p, temp) {
    if (!p.over) return; // まだ描いていないページ
    const ctx = p.over.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.over.width, p.over.height);
    ctx.setTransform(p.px, 0, 0, p.px, 0, 0);
    ctx.transform(...p.toDisp);
    p.items.forEach((a) => drawAnnotation(ctx, a));
    if (temp) drawAnnotation(ctx, temp);
    if (selected && selected.p === p) drawAnnSelection(ctx, selected.item, scaleOf(p));
  }

  /* ---------- ページを並べる・見えてきたページから描く ---------- */
  let observer = null;
  let renderChain = Promise.resolve();

  // ページの枠だけ作る(中身は見えてきたら描く)
  function layoutPage(p) {
    const s = scaleOf(p);
    p.layoutId = (p.layoutId || 0) + 1;
    p.rendered = false;
    p.base = p.over = null;
    p.wrap.style.width = `${p.disp.width * s}px`;
    p.wrap.style.height = `${p.disp.height * s}px`;
    p.wrap.innerHTML = `<div class="ann-page-loading">読み込み中…</div>`;
  }

  function queueRender(p) {
    if (p.queued || p.rendered) return;
    p.queued = true;
    renderChain = renderChain.then(() => renderPage(p)).catch((err) => console.error("図面を表示できませんでした", err));
  }

  async function renderPage(p) {
    p.queued = false;
    if (p.rendered || !p.wrap.isConnected) return;
    const id = p.layoutId;
    const s = scaleOf(p);
    const dpr = window.devicePixelRatio || 1;
    const px = Math.min(s * dpr, Math.sqrt(ANN_MAX_CANVAS_PX / (p.disp.width * p.disp.height)));
    const base = document.createElement("canvas");
    const over = document.createElement("canvas");
    over.className = "ann-over";
    over.dataset.page = pages.indexOf(p);
    [base, over].forEach((c) => {
      c.width = Math.round(p.disp.width * px);
      c.height = Math.round(p.disp.height * px);
      c.style.width = `${p.disp.width * s}px`;
      c.style.height = `${p.disp.height * s}px`;
    });
    await p.page.render({
      canvasContext: base.getContext("2d"),
      viewport: p.page.getViewport({ scale: px, rotation: p.disp.rotation }),
    }).promise;
    if (id !== p.layoutId || !p.wrap.isConnected) return; // 描いている間に拡大・回転された
    p.wrap.replaceChildren(base, over);
    Object.assign(p, { base, over, px, rendered: true });
    redraw(p);
    syncCursor();
  }

  function renderAll() {
    if (observer) observer.disconnect();
    document.getElementById("annZoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
    pagesEl.innerHTML = "";
    pages.forEach((p, idx) => {
      const block = document.createElement("div");
      block.className = "ann-page-block";
      block.innerHTML = `
        <div class="ann-page-head">
          <span>${idx + 1} / ${pages.length} ページ</span>
          <button type="button" class="ann-btn" data-rotate="-90" data-page="${idx}" title="このページを左に90度回す">⟲ 左に回す</button>
          <button type="button" class="ann-btn" data-rotate="90" data-page="${idx}" title="このページを右に90度回す">⟳ 右に回す</button>
        </div>`;
      p.wrap = document.createElement("div");
      p.wrap.className = "ann-page";
      p.wrap.dataset.page = idx;
      block.appendChild(p.wrap);
      pagesEl.appendChild(block);
      layoutPage(p);
    });
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.isIntersecting && queueRender(pages[Number(e.target.dataset.page)]));
    }, { root: pagesEl, rootMargin: "800px 0px" });
    pages.forEach((p) => observer.observe(p.wrap));
    // 最初から見えているページは、知らせを待たずにすぐ描き始める
    const view = pagesEl.getBoundingClientRect();
    pages.forEach((p) => {
      const r = p.wrap.getBoundingClientRect();
      if (r.top < view.bottom + 800 && r.bottom > view.top - 800) queueRender(p);
    });
  }

  function rotatePage(p, delta) {
    closeTextBox(true);
    setRot(p, p.rot + delta);
    layoutPage(p);
    queueRender(p);
  }

  /* ---------- 道具の表示 ---------- */
  function syncToolbar() {
    document.querySelectorAll("#annTools [data-tool]").forEach((b) => b.classList.toggle("is-on", b.dataset.tool === state.tool));
    document.querySelectorAll("#annModal [data-color]").forEach((b) => b.classList.toggle("is-on", b.dataset.color === state.color));
    document.querySelectorAll("#annModal [data-size]").forEach((b) => b.classList.toggle("is-on", b.dataset.size === state.size));
    document.getElementById("annDelete").disabled = !selected;
    document.getElementById("annUndo").disabled = !history.length;
    document.getElementById("annRedo").disabled = !redoStack.length;
    syncCursor();
  }

  function syncCursor() {
    const cur = state.tool === "select" ? "default" : state.tool === "text" ? "text" : "crosshair";
    pages.forEach((p) => p.over && (p.over.style.cursor = cur));
  }

  function select(sel) {
    const old = selected;
    selected = sel;
    if (old) redraw(old.p);
    if (sel && (!old || sel.p !== old.p)) redraw(sel.p);
    syncToolbar();
  }

  /* ---------- 戻す・やり直す ---------- */
  function record(act) {
    history.push(act);
    redoStack.length = 0;
    syncToolbar();
  }

  function applyAct(act, undo) {
    const { p } = act;
    const removeItem = () => p.items.splice(p.items.indexOf(act.item), 1);
    if (act.type === "add") undo ? removeItem() : p.items.push(act.item);
    if (act.type === "delete") undo ? p.items.splice(act.index, 0, act.item) : removeItem();
    if (act.type === "move") annMove(act.item, undo ? -act.dx : act.dx, undo ? -act.dy : act.dy);
    if (act.type === "rotate") rotatePage(p, undo ? -act.delta : act.delta);
    else redraw(p);
  }

  function commit(p, item) {
    p.items.push(item);
    record({ type: "add", p, item });
    redraw(p);
  }

  function deleteSelected() {
    if (!selected) return;
    const { p, item } = selected;
    const index = p.items.indexOf(item);
    p.items.splice(index, 1);
    select(null);
    record({ type: "delete", p, item, index });
    redraw(p);
  }

  // 画面の位置 → PDFの点(回す前の向き)
  function pointOf(p, ev) {
    const r = p.over.getBoundingClientRect();
    const s = scaleOf(p);
    return U.applyTransform([(ev.clientX - r.left) / s, (ev.clientY - r.top) / s], p.toBase);
  }

  // いちばん上に描かれている書き込みから順に、クリックした所に当たる物を探す
  function findItem(p, x, y) {
    const tol = ANN_HIT_PX / scaleOf(p);
    for (let i = p.items.length - 1; i >= 0; i--) {
      if (annHit(p.items[i], x, y, tol)) return p.items[i];
    }
    return null;
  }

  /* ---------- 描く・動かす ---------- */
  let drag = null; // { mode: "draw"|"move", p, item, ... }
  let textBox = null;

  function closeTextBox(save) {
    if (!textBox) return;
    const { input, p, x, y, size, color, rot } = textBox;
    textBox = null;
    const text = input.value.trim();
    input.remove();
    if (save && text) commit(p, { type: "text", x, y, text, size, color, rot });
  }

  function openTextBox(p, x, y) {
    closeTextBox(true);
    const s = scaleOf(p);
    const [dx, dy] = U.applyTransform([x, y], p.toDisp);
    const size = ANN_SIZES[state.size].text;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ann-text-input";
    input.style.left = `${dx * s}px`;
    input.style.top = `${dy * s}px`;
    input.style.fontSize = `${size * s}px`;
    input.style.color = state.color;
    input.placeholder = "文字を入力して Enter";
    p.wrap.appendChild(input);
    textBox = { input, p, x, y, size, color: state.color, rot: p.rot };
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
    if (state.tool === "select") {
      const item = findItem(p, x, y);
      select(item ? { p, item } : null);
      if (!item) return;
      drag = { mode: "move", p, item, sx: x, sy: y, lx: x, ly: y };
    } else {
      const sz = ANN_SIZES[state.size];
      const t = state.tool;
      const item = t === "pen" || t === "whitePen"
        ? { type: t, points: [[x, y]], width: t === "pen" ? sz.pen : sz.white, color: state.color }
        : { type: t, x1: x, y1: y, x2: x, y2: y, width: sz.pen, color: state.color };
      drag = { mode: "draw", p, item };
    }
    try {
      canvas.setPointerCapture(ev.pointerId); // 図面の外までドラッグしても続ける
    } catch (e) { /* 取れない環境では無くても描ける */ }
  };
  pagesEl.onpointermove = (ev) => {
    if (!drag) {
      // 「選んで動かす」のとき、書き込みの上ではカーソルを移動の形にする
      const canvas = state.tool === "select" && ev.target.closest(".ann-over");
      if (canvas) {
        const p = pages[Number(canvas.dataset.page)];
        canvas.style.cursor = findItem(p, ...pointOf(p, ev)) ? "move" : "default";
      }
      return;
    }
    const [x, y] = pointOf(drag.p, ev);
    if (drag.mode === "move") {
      annMove(drag.item, x - drag.lx, y - drag.ly);
      drag.lx = x;
      drag.ly = y;
      return redraw(drag.p);
    }
    if (drag.item.points) drag.item.points.push([x, y]);
    else Object.assign(drag.item, { x2: x, y2: y });
    redraw(drag.p, drag.item);
  };
  pagesEl.onpointerup = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === "move") {
      const dx = d.lx - d.sx, dy = d.ly - d.sy;
      if (dx || dy) record({ type: "move", p: d.p, item: d.item, dx, dy });
      return;
    }
    const { p, item } = d;
    const tiny = !item.points && Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 2;
    if (tiny) return redraw(p); // クリックしただけのときは描かない
    commit(p, item);
  };

  // ページの回転ボタン
  pagesEl.onclick = (ev) => {
    const b = ev.target.closest("[data-rotate]");
    if (!b) return;
    const p = pages[Number(b.dataset.page)];
    const delta = Number(b.dataset.rotate);
    rotatePage(p, delta);
    record({ type: "rotate", p, delta });
  };

  /* ---------- 道具・色・太さ・消す・戻す・拡大 ---------- */
  const toolbar = modal.querySelector(".ann-toolbar");
  toolbar.onclick = (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) {
      state.tool = b.dataset.tool;
      if (state.tool !== "select") select(null);
    }
    if (b.dataset.color) state.color = b.dataset.color;
    if (b.dataset.size) state.size = b.dataset.size;
    if (b.id === "annDelete") deleteSelected();
    if ((b.id === "annUndo" && history.length) || (b.id === "annRedo" && redoStack.length)) {
      closeTextBox(true);
      select(null);
      const undo = b.id === "annUndo";
      const act = (undo ? history : redoStack).pop();
      applyAct(act, undo);
      (undo ? redoStack : history).push(act);
    }
    if (b.id === "annZoomIn" || b.id === "annZoomOut") {
      closeTextBox(true);
      const steps = [0.5, 0.75, 1, 1.5, 2, 3];
      const i = steps.indexOf(state.zoom);
      state.zoom = steps[Math.max(0, Math.min(steps.length - 1, i + (b.id === "annZoomIn" ? 1 : -1)))];
      renderAll();
    }
    syncToolbar();
  };

  /* ---------- 保存：書き込みを透明な画像にして各ページに重ね、回した分をページの向きにする ---------- */
  async function buildPdf() {
    const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const docPages = doc.getPages();
    for (const [i, p] of pages.entries()) {
      if (p.rot) docPages[i].setRotation(PDFLib.degrees((p.page.rotate + p.rot) % 360));
      if (!p.items.length) continue;
      const W = p.view.width, H = p.view.height;
      const c = document.createElement("canvas");
      c.width = Math.round(W * ANN_SAVE_SCALE);
      c.height = Math.round(H * ANN_SAVE_SCALE);
      const ctx = c.getContext("2d");
      ctx.setTransform(ANN_SAVE_SCALE, 0, 0, ANN_SAVE_SCALE, 0, 0);
      p.items.forEach((a) => drawAnnotation(ctx, a));
      const png = await doc.embedPng(c.toDataURL("image/png"));
      // 画面の左下・右下がPDFのどこに当たるかから、置く位置と向きを決める(元から回っているページにも対応)
      const [ox, oy] = p.view.convertToPdfPoint(0, H);
      const [ax, ay] = p.view.convertToPdfPoint(W, H);
      const angle = Math.atan2(ay - oy, ax - ox) * 180 / Math.PI;
      docPages[i].drawImage(png, { x: ox, y: oy, width: W, height: H, rotate: PDFLib.degrees(angle) });
    }
    const out = await doc.save();
    return new File([out], fileName, { type: "application/pdf" });
  }

  syncToolbar();
  renderAll();

  return new Promise((resolve) => {
    const onKey = (ev) => {
      if (textBox || !selected) return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        deleteSelected();
      }
    };
    document.addEventListener("keydown", onKey);
    const close = (result) => {
      closeTextBox(false);
      document.removeEventListener("keydown", onKey);
      if (observer) observer.disconnect();
      modal.classList.remove("open");
      pagesEl.innerHTML = "";
      resolve(result);
    };
    const hasEdits = () => pages.some((p) => p.items.length || p.rot);
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

// 書き込み画面を開いたときに待たないよう、PDFの部品は手が空いたときに先に読み込んでおく
(window.requestIdleCallback || ((f) => setTimeout(f, 2000)))(() => splitPartsReady().catch(() => {}));
