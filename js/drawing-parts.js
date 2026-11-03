/* =========================================================
   未来栄株式会社 図面管理システム  図面の図番・品名・数量
   ---------------------------------------------------------
   書類の一覧の「図面」1枚ごとに、図面に書かれた正式な図番・品名・数量を入れる欄を出す。
   入れた内容は突き合わせ表の行(caseItems)になり、drawingFileId でその図面と結びつく。
   注文書・納品書・請求書の品物は表の行から作るので、そのまま使われる。

   使い方(案件ページ・進行中の「書類」画面)：
     const editor = createDrawingPartsEditor({
       rows: () => 案件の表の行の配列,
       customer: () => 客先名, productCode: () => 品番,
       rerender: () => 書類の一覧を描き直す,
       onSaved: (row) => 行が増えた・変わったあと(任意),
       drawingFiles: () => この案件の「図面」の書類(orderFiles)の配列,
       refFiles: () => 数量などの手がかりになる書類(客先からの注文書・注文メールなど)の配列,
       request: () => AI読み取りの依頼に入れる案件の情報 { caseKey, orderId, customer, caseCode, title },
     });
     書類の一覧の図面の下に editor.html(ファイルID)、図面の見出しの下に editor.aiBarHtml() を入れ、
     一覧の入れ物で editor.bind(入れ物) を1回呼ぶ。開いたときに await editor.refresh() で依頼の状態とAIの下書きを読む。

   AI読み取り(2026-11-03〜)：
     「🤖 AIで読み取りを依頼」を押すと aiRequests に依頼が入る。管理者のPCの見回り(03_未来栄/AI読み取り/ai_worker.py)が
     依頼を見つけると、図面と注文書をClaude Codeで読み、結果を orderFiles/{ID}.aiDraft に書く。
     画面ではAIの結果を「下書き」として欄に入れ、人が図面と見くらべて「登録」する(自動では登録しない)。
   ========================================================= */

const AI_REQUEST_COLLECTION = "aiRequests";

// この案件のAI読み取りの依頼(新しい順)
async function fetchAiRequests(key) {
  const snap = await db.collection(AI_REQUEST_COLLECTION).where("key", "==", key).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.requestedAtText || "").localeCompare(String(a.requestedAtText || "")));
}

async function addAiRequest(data) {
  const now = new Date();
  const ref = await db.collection(AI_REQUEST_COLLECTION).add({
    ...data,
    status: "pending",
    requestedBy: auth.currentUser ? auth.currentUser.email : "",
    requestedAtText: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

function createDrawingPartsEditor(ctx) {
  // まだ保存していない入力(図番を入れて「登録」を押す前)。ファイルID → [{ drawingNo, productName, qty }]
  const drafts = new Map();
  const aiDrafts = new Map(); // ファイルID → AIの読み取り結果 { parts: [...], readAtText }
  let aiRequests = [];        // この案件の依頼(新しい順)

  function linkedRows(fileId) {
    return ctx.rows().filter((r) => r.drawingFileId === fileId);
  }

  // 結びついた行が無い図面には、AIの下書き(あれば)か空の入力欄を出しておく
  function draftsOf(fileId) {
    if (!drafts.has(fileId)) {
      const ai = aiDrafts.get(fileId);
      let list = [];
      if (!linkedRows(fileId).length) {
        list = ai && (ai.parts || []).length
          ? ai.parts.map((p) => ({ drawingNo: p.drawingNo || "", productName: p.productName || "", qty: p.qty ?? 1, ai: true, note: p.note || "" }))
          : [{ drawingNo: "", productName: "", qty: 1 }];
      }
      drafts.set(fileId, list);
    }
    return drafts.get(fileId);
  }

  const isBlankDraft = (d) => !d.ai && !String(d.drawingNo || "").trim() && !String(d.productName || "").trim();

  // 依頼の状態と、各図面のAIの下書きを読み直す(書類の画面を開いたとき)
  async function refresh() {
    const req = ctx.request ? ctx.request() : null;
    if (!req || !ctx.productCode()) return;
    try {
      aiRequests = await fetchAiRequests(req.key);
    } catch (err) {
      console.warn("AI読み取りの依頼を読めませんでした(Firestoreのルールに aiRequests が必要です)", err);
      aiRequests = [];
    }
    for (const f of ctx.drawingFiles()) {
      try {
        const snap = await db.collection(ORDER_FILE_COLLECTION).doc(f.id).get();
        const ai = snap.exists ? snap.data().aiDraft : null;
        if (ai) aiDrafts.set(f.id, ai);
        else aiDrafts.delete(f.id);
      } catch (err) {
        console.warn("AIの下書きを読めませんでした", err);
      }
      // まだ何も入れていない欄は、AIの下書きで入れ直す
      const ds = drafts.get(f.id);
      if (ds && ds.every(isBlankDraft)) drafts.delete(f.id);
    }
  }

  // 図番がまだ入っていない(行が無く、AIの下書きも無い)図面
  function unreadDrawings() {
    return ctx.drawingFiles().filter((f) => !linkedRows(f.id).length && !aiDrafts.has(f.id));
  }

  // 図面の見出しの下に出す「AIで読み取りを依頼」と依頼の状態
  function aiBarHtml() {
    if (!ctx.request || !ctx.productCode() || !ctx.drawingFiles().length) return "";
    const last = aiRequests[0];
    const waiting = last && (last.status === "pending" || last.status === "working");
    const n = unreadDrawings().length;
    let status = "";
    if (last && last.status === "pending") status = `⏳ ${escapeHtml(last.requestedAtText || "")} に依頼済み。管理者のPCが読み取ると、図番・品名・数量の欄に下書きが入ります（読み取りは平日9:00〜22:00。時間外の依頼は次の平日の朝に読み取ります）。`;
    else if (last && last.status === "working") status = "🤖 いま読み取っています。少し待ってから画面を開き直してください。";
    else if (last && last.status === "done") status = `✅ ${escapeHtml(last.doneAtText || "")} に読み取りました。${escapeHtml(last.message || "")}`;
    else if (last && last.status === "error") status = `⚠ 読み取りできませんでした：${escapeHtml(last.message || "")}`;
    return `
      <div class="dp-ai-bar">
        <button type="button" class="btn btn-secondary btn-sm" data-dp-ai-request ${waiting || !n ? "disabled" : ""}
          title="図面と注文書をAIが読んで、図番・品名・数量の下書きを入れます。結果は人が確認して「登録」します">
          🤖 AIで読み取りを依頼（管理者に通知）${n ? `　${n}枚` : ""}</button>
        <span class="dp-ai-status">${status || (n ? "" : "図番がまだの図面はありません。")}</span>
      </div>`;
  }

  async function requestAi() {
    const files = unreadDrawings();
    if (!files.length) return toast("図番がまだの図面はありません。");
    if (!confirm(`図番・品名・数量がまだの図面${files.length}枚を、AIで読み取るよう管理者に依頼します。
` +
      "図面と注文書の画像はAI(Anthropic社)に送られます。よろしいですか？")) return;
    try {
      await addAiRequest({
        ...ctx.request(),
        fileIds: files.map((f) => f.id),
        refFileIds: (ctx.refFiles ? ctx.refFiles() : []).map((f) => f.id),
      });
      await refresh();
      ctx.rerender();
      toast("管理者に通知しました。平日9:00〜22:00に読み取り、終わると欄に下書きが入ります。");
    } catch (err) {
      console.error("AI読み取りの依頼に失敗しました", err);
      toast("依頼できませんでした：" + (err && err.code === "permission-denied"
        ? "Firestoreのルールに aiRequests を追加してください。" : (err.message || err)));
    }
  }

  function inputs(attr, v) {
    return `
      <input type="text" class="dp-no" ${attr} data-k="drawingNo" value="${escapeHtml(v.drawingNo || "")}" placeholder="図番" autocomplete="off">
      <input type="text" class="dp-name" ${attr} data-k="productName" value="${escapeHtml(v.productName || "")}" placeholder="品名" autocomplete="off">
      <input type="number" min="0" class="dp-qty" ${attr} data-k="qty" value="${escapeHtml(v.qty ?? "")}" placeholder="数量">`;
  }

  function html(fileId) {
    if (!ctx.productCode()) {
      return `<div class="dp-editor dp-editor-off">🔩 図番・品名・数量は、品番のある案件で入れられます。</div>`;
    }
    const rows = linkedRows(fileId);
    const ds = draftsOf(fileId);
    return `
      <div class="dp-editor" data-dp-file="${escapeHtml(fileId)}">
        <div class="dp-head">🔩 図番・品名・数量 <small>注文書・納品書・請求書の品物になります</small></div>
        ${rows.map((r) => `
          <div class="dp-row">${inputs(`data-dp-row="${escapeHtml(r.id)}"`, r)}<span class="dp-ok" title="保存済み">✓</span></div>`).join("")}
        ${ds.some((d) => d.ai) ? `<div class="dp-ai-note">🤖 AIの読み取り結果です。図面と見くらべて、正しければ「登録」を押してください。</div>` : ""}
        ${ds.map((d, i) => `
          ${d.ai && d.note ? `<div class="dp-ai-note dp-ai-memo">メモ：${escapeHtml(d.note)}</div>` : ""}
          <div class="dp-row dp-draft${d.ai ? " dp-ai" : ""}">
            ${inputs(`data-dp-draft="${i}"`, d)}
            <button type="button" class="btn btn-primary btn-sm" data-dp-save="${i}">登録</button>
            ${rows.length || ds.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-dp-cancel="${i}" title="この入力欄を消す">×</button>` : ""}
          </div>`).join("")}
        ${rows.length && !ds.length ? `<button type="button" class="btn btn-ghost btn-sm dp-more" data-dp-more title="この図面に載っている別の部品を追加します">＋ 部品</button>` : ""}
      </div>`;
  }

  const readValue = (el) => el.dataset.k === "qty" ? (el.value === "" ? 0 : Number(el.value) || 0) : el.value.trim();

  // 同じ案件で、ほかの行と図番が重ならないか
  function clashes(drawingNo, exceptId) {
    return ctx.rows().some((r) => r.id !== exceptId && r.drawingNo === drawingNo);
  }

  // 保存済みの行を直す(欄を離れたとき)
  async function saveRowField(el) {
    const r = ctx.rows().find((x) => x.id === el.dataset.dpRow);
    if (!r) return;
    const key = el.dataset.k;
    const value = readValue(el);
    if (key === "drawingNo" && !value) {
      el.value = r.drawingNo || "";
      return toast("図番は空にできません。");
    }
    if (key === "drawingNo" && clashes(value, r.id)) {
      el.value = r.drawingNo || "";
      return toast(`図番「${value}」の部品はすでにあります。`);
    }
    if ((r[key] ?? "") === value) return;
    try {
      await updateCaseItem(r.id, { [key]: value });
      r[key] = value;
      toast("保存しました");
      if (ctx.onSaved) ctx.onSaved(r);
    } catch (err) {
      console.error("図番・品名・数量の保存に失敗しました", err);
      toast("保存できませんでした。");
    }
  }

  let saving = false;

  // まだ保存していない入力を行にする。同じ図番の行がすでにあれば、その行に図面を結びつける
  async function saveDraft(container, fileId, i) {
    const d = draftsOf(fileId)[i];
    const drawingNo = String(d.drawingNo || "").trim();
    if (!drawingNo) return toast("図番を入れてください。");
    const same = ctx.rows().find((r) => r.drawingNo === drawingNo);
    if (same && same.drawingFileId && same.drawingFileId !== fileId &&
        !confirm(`図番「${drawingNo}」の部品は、別の図面に結びついています。この図面に付け替えますか？`)) return;
    if (saving) return;
    saving = true;
    try {
      const row = await saveDrawingPart({
        customer: ctx.customer(), productCode: ctx.productCode(), drawingNo,
        productName: String(d.productName || "").trim(),
        qty: d.qty === "" || d.qty === null ? 0 : Number(d.qty) || 0,
        drawingFileId: fileId,
      });
      const rows = ctx.rows();
      const at = rows.findIndex((r) => r.id === row.id);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      draftsOf(fileId).splice(i, 1);
      toast(`図番「${drawingNo}」を登録しました`);
      if (ctx.onSaved) ctx.onSaved(row);
      ctx.rerender();
      // 続けて入れられるよう、まだ入れていない次の図面の図番の欄へ
      const next = container.querySelector('.dp-draft input[data-k="drawingNo"]');
      if (next) next.focus();
    } catch (err) {
      console.error("図番・品名・数量の保存に失敗しました", err);
      toast("保存できませんでした：" + (err.message || err));
    } finally {
      saving = false;
    }
  }

  function bind(container) {
    const fileOf = (el) => el.closest("[data-dp-file]").dataset.dpFile;
    container.addEventListener("input", (ev) => {
      const el = ev.target.closest("[data-dp-draft]");
      if (el && el.closest("[data-dp-file]")) draftsOf(fileOf(el))[Number(el.dataset.dpDraft)][el.dataset.k] = el.value;
    });
    container.addEventListener("change", (ev) => {
      const el = ev.target.closest("[data-dp-row]");
      if (el) saveRowField(el);
    });
    container.addEventListener("keydown", (ev) => {
      const el = ev.target.closest("[data-dp-draft]");
      if (el && ev.key === "Enter") {
        ev.preventDefault();
        saveDraft(container, fileOf(el), Number(el.dataset.dpDraft));
      }
    });
    container.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-dp-ai-request]")) return requestAi();
      const save = ev.target.closest("[data-dp-save]");
      if (save) return saveDraft(container, fileOf(save), Number(save.dataset.dpSave));
      const cancel = ev.target.closest("[data-dp-cancel]");
      if (cancel) {
        draftsOf(fileOf(cancel)).splice(Number(cancel.dataset.dpCancel), 1);
        return ctx.rerender();
      }
      const more = ev.target.closest("[data-dp-more]");
      if (more) {
        const fileId = fileOf(more);
        draftsOf(fileId).push({ drawingNo: "", productName: "", qty: 1 });
        ctx.rerender();
        const input = container.querySelector(`[data-dp-file="${CSS.escape(fileId)}"] .dp-draft input[data-k="drawingNo"]`);
        if (input) input.focus();
      }
    });
  }

  return {
    html,
    aiBarHtml,
    refresh,
    bind,
    // 案件が変わったとき(進行中の「書類」画面を開き直したとき)に、保存前の入力を捨てる
    reset: () => drafts.clear(),
  };
}

// 図面を削除したとき、その図面を指していた行を「図面なし」にする(行そのものは残す)
async function unlinkDrawingFile(rows, fileId) {
  for (const r of rows.filter((x) => x.drawingFileId === fileId)) {
    await updateCaseItem(r.id, { drawingFileId: "" });
    r.drawingFileId = "";
  }
}
