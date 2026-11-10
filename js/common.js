/* ==========================================================
   未来栄株式会社 図面管理システム 共通スクリプト
   認証: Firebase Authentication / 図面データ: Firestore(drawingsコレクション)
   ========================================================== */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ページ内で検索・詳細表示に使う図面データ。fetchDrawings()で読み込む。
let DRAWINGS = [];

// Firebase Authは初期化直後にログイン状態が確定していないため、
// 最初のonAuthStateChanged発火を待ってから現在のユーザーを返す。
let authReadyPromise = null;
function waitForAuthUser() {
  if (!authReadyPromise) {
    authReadyPromise = new Promise((resolve) => {
      const unsubscribe = auth.onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user);
      });
    });
  }
  return authReadyPromise;
}

// Firestoreからdrawingsコレクションを取得し、DRAWINGSに読み込む
async function fetchDrawings() {
  try {
    const snapshot = await db.collection("drawings").orderBy("updatedAt", "desc").get();
    DRAWINGS = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    console.error("図面データの取得に失敗しました", err);
    DRAWINGS = [];
  }
  return DRAWINGS;
}

const PART_LABELS = {
  pulley: "プーリー",
  roller: "ローラー",
  belt: "ベルト",
  alignment: "調芯",
  other: "その他",
};

const MATERIAL_LABELS = {
  resin: "樹脂",
  metal: "金属",
};

const LOCATION_LABELS = {
  outdoor: "屋外",
  indoor: "室内",
};

// ---------- ログイン(Firebase Authentication) ----------
async function loginWithPassword(email, password) {
  try {
    const { user } = await auth.signInWithEmailAndPassword(email, password);
    if (!(await isAllowedUser(user))) {
      await auth.signOut();
      return { ok: false, denied: true };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// 利用を許可された人か(Firestoreの appUsers/{uid} があるか)。
// 本当の守りはFirestoreのルール(同じ条件)で、ここは「使えない人に分かるように知らせる」ためのもの。
// 通信エラーなどで確かめられないときは通す(ルールが守るので、データは見えない)。
async function isAllowedUser(user) {
  try {
    const snap = await db.collection("appUsers").doc(user.uid).get();
    return snap.exists;
  } catch (err) {
    console.error("利用者の確認ができませんでした", err);
    return true;
  }
}

// ログイン必須ページの先頭で呼ぶ。未ログイン・使えない人ならログイン画面へ飛ばしてfalseを返す。
async function requireLogin() {
  const user = await waitForAuthUser();
  if (!user) {
    window.location.href = "login.html";
    return false;
  }
  if (!(await isAllowedUser(user))) {
    await auth.signOut();
    window.location.href = "login.html?denied=1";
    return false;
  }
  return true;
}

async function currentUserName() {
  const user = await waitForAuthUser();
  return user ? user.email : "ゲスト";
}

async function logout() {
  await auth.signOut();
  window.location.href = "login.html";
}

// ログイン必須ページの共通初期化。認証チェック＋ユーザー名表示＋(必要なら)図面データ読み込みをまとめて行う。
async function initPage({ loadDrawings = false } = {}) {
  const ok = await requireLogin();
  if (!ok) return false;

  const nameLabel = document.getElementById("userNameLabel");
  if (nameLabel) nameLabel.textContent = (await currentUserName()) + " さん";

  // 客先・外注先の名前は公開ファイルに書かず Firestore から読む(case-store.js)
  if (typeof loadPartners === "function") await loadPartners();

  if (loadDrawings) await fetchDrawings();

  return true;
}

// ---------- フィルタリング共通ロジック ----------
// filterState: { location: "any"|"outdoor"|"indoor", materials: [], parts: [],
//                rollDiameterMin/Max, rollLengthMin/Max, conveyorWidthMin/Max, conveyorLengthMin/Max }
function filterDrawings(filterState) {
  return DRAWINGS.filter((d) => {
    if (filterState.location && filterState.location !== "any" && d.location !== filterState.location) {
      return false;
    }
    if (filterState.materials && filterState.materials.length > 0) {
      const hit = filterState.materials.some((m) => d.material.includes(m));
      if (!hit) return false;
    }
    if (filterState.parts && filterState.parts.length > 0) {
      const hit = filterState.parts.some((p) => d.parts.includes(p));
      if (!hit) return false;
    }
    // 寸法は下限・上限を指定し、その範囲に入る図面を検索する
    if (!inRange(d.rollDiameter, filterState.rollDiameterMin, filterState.rollDiameterMax)) return false;
    if (!inRange(d.rollLength, filterState.rollLengthMin, filterState.rollLengthMax)) return false;
    if (!inRange(d.conveyorWidth, filterState.conveyorWidthMin, filterState.conveyorWidthMax)) return false;
    if (!inRange(d.conveyorLength, filterState.conveyorLengthMin, filterState.conveyorLengthMax)) return false;
    return true;
  });
}

// value が min〜max の範囲内かどうかを判定する(min/maxは未入力なら制限なし)
function inRange(value, min, max) {
  if (min !== undefined && min !== null && min !== "" && Number(min) > 0 && value < Number(min)) return false;
  if (max !== undefined && max !== null && max !== "" && Number(max) > 0 && value > Number(max)) return false;
  return true;
}

function badgeHtml(d) {
  const badges = [];
  badges.push(
    `<span class="badge ${d.location === "outdoor" ? "badge-outdoor" : "badge-indoor"}">${LOCATION_LABELS[d.location]}</span>`
  );
  d.material.forEach((m) => {
    badges.push(`<span class="badge ${m === "resin" ? "badge-resin" : "badge-metal"}">${MATERIAL_LABELS[m]}</span>`);
  });
  return badges.join("");
}

function partsLabelText(d) {
  return d.parts.map((p) => PART_LABELS[p]).join("・");
}

// ---------- 必要な材料一覧(ダミー生成) ----------
// 部品名ごとの代表的な材料と仕様の作り方を定義しておき、
// 図面の寸法・材質から必要材料の表データをその場で組み立てる。
const PART_MATERIAL_SPECS = {
  pulley: { name: "プーリー", unit: "個", specFn: (d) => `Φ${d.rollDiameter}×幅${d.conveyorWidth}mm`, qtyFn: () => 2 },
  roller: { name: "ローラー", unit: "個", specFn: (d) => `Φ${d.rollDiameter}×長さ${d.rollLength}mm`, qtyFn: (d) => Math.max(3, Math.round(d.conveyorLength / 800)) },
  belt: { name: "コンベヤベルト", unit: "本", specFn: (d) => `幅${d.conveyorWidth}×長さ${d.conveyorLength}mm`, qtyFn: () => 1 },
  alignment: { name: "調芯ローラーユニット", unit: "個", specFn: (d) => `Φ${d.rollDiameter}mm 調芯機構付き`, qtyFn: () => 2 },
  other: { name: "その他付属部品一式", unit: "式", specFn: () => "仕様は個別図面による", qtyFn: () => 1 },
};

function getRequiredMaterials(d) {
  const materialLabel = d.material.map((m) => MATERIAL_LABELS[m]).join("・");
  const rows = [];

  // 選択された部品ごとの材料行
  d.parts.forEach((p) => {
    const spec = PART_MATERIAL_SPECS[p];
    if (!spec) return;
    rows.push({
      name: spec.name,
      material: materialLabel,
      spec: spec.specFn(d),
      qty: spec.qtyFn(d),
      unit: spec.unit,
    });
  });

  // どの図面にも共通してつく基礎部材(モック用ダミー)
  rows.push({
    name: "本体フレーム",
    material: d.material.includes("metal") ? "金属(SS400相当)" : "樹脂",
    spec: `幅${d.conveyorWidth}×長さ${d.conveyorLength}mm`,
    qty: 1,
    unit: "式",
  });
  rows.push({
    name: "軸受(ベアリング)",
    material: "金属",
    spec: `軸径Φ${Math.max(8, Math.round(d.rollDiameter * 0.25))}mm相当`,
    qty: d.parts.includes("roller") ? 4 : 2,
    unit: "個",
  });
  rows.push({
    name: "駆動モーター",
    material: "-",
    spec: "汎用ギアモーター",
    qty: 1,
    unit: "台",
  });
  rows.push({
    name: "ボルト・ナットセット",
    material: "金属",
    spec: "M8相当",
    qty: 1,
    unit: "式",
  });

  // 表示用の連番を付与
  return rows.map((r, i) => ({ no: i + 1, ...r }));
}

function toast(message) {
  let el = document.getElementById("mockToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "mockToast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- ポップアップ(モーダル)をドラッグで動かす ----------
   どの画面のポップアップも、上の見出しの帯(.modal-head)をつかんで動かせる。
   閉じて開き直すと、元の真ん中の位置にもどる。 */
(function enableModalDrag() {
  let drag = null;        // { box, startX, startY, baseX, baseY, moved }
  let swallowClick = false;

  document.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const head = ev.target.closest(".modal-overlay .modal-head");
    if (!head) return;
    // ×ボタンや入力欄はふつうに使えるようにする
    if (ev.target.closest("button, a, input, select, textarea, label, [contenteditable]")) return;
    const box = head.closest(".modal-box") || head.parentElement;
    drag = {
      box,
      startX: ev.clientX,
      startY: ev.clientY,
      baseX: parseFloat(box.dataset.dragX) || 0,
      baseY: parseFloat(box.dataset.dragY) || 0,
      moved: false,
    };
    ev.preventDefault(); // 文字の選択を防ぐ
  });

  document.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    let dx = ev.clientX - drag.startX;
    let dy = ev.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    // 見出しの帯が画面の外に出てしまわないようにする
    const r = drag.box.getBoundingClientRect();
    const curX = parseFloat(drag.box.dataset.dragX) || 0;
    const curY = parseFloat(drag.box.dataset.dragY) || 0;
    const left0 = r.left - curX, top0 = r.top - curY; // 動かす前の位置
    let x = drag.baseX + dx, y = drag.baseY + dy;
    x = Math.min(Math.max(x, 80 - left0 - r.width), window.innerWidth - 80 - left0);
    y = Math.min(Math.max(y, -top0), window.innerHeight - 50 - top0);
    drag.box.dataset.dragX = x;
    drag.box.dataset.dragY = y;
    drag.box.style.transform = `translate(${x}px, ${y}px)`;
  });

  const endDrag = () => {
    if (drag && drag.moved) {
      swallowClick = true; // ドラッグを離したときに背景クリックで閉じないように
      setTimeout(() => { swallowClick = false; }, 0);
    }
    drag = null;
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("click", (ev) => {
    if (swallowClick) { ev.stopPropagation(); ev.preventDefault(); swallowClick = false; }
  }, true);

  // 開き直したら真ん中にもどす
  const reset = (overlay) => {
    overlay.querySelectorAll(".modal-box").forEach((box) => {
      delete box.dataset.dragX;
      delete box.dataset.dragY;
      box.style.transform = "";
    });
  };
  const watch = () => {
    new MutationObserver((list) => {
      list.forEach((m) => {
        if (m.type === "attributes" && m.target.classList.contains("modal-overlay") &&
            !m.target.classList.contains("open")) reset(m.target);
      });
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
  };
  watch();
})();

/* ---------- ポップアップの「元に戻す／やり直す」 ----------
   registerModalUndo("ポップアップのID", extra?) を呼んだポップアップの見出しに「↶ 戻す」「↷ 進む」を出す。
   ・入力欄(idのあるもの、ラジオ・チェックは name)の値は自動で覚える
   ・明細の行など、画面の裏の配列で持っている内容は extra = { get: () => 値, set: (値) => 描き直し } で渡す
   ・保存する前の入力だけが対象。保存・削除・印刷などのあとの操作は戻せない
   ・ポップアップを開いて最初にさわったときの状態から覚え始め、閉じると忘れる
   ・キーボード：Ctrl+Z で戻す、Ctrl+Y(または Ctrl+Shift+Z)で進む。文字を入れている欄の中では、その欄の文字の取り消しになる */
const MODAL_UNDO = new Map(); // ID → { extra, stack, index, timer, restoring, undoBtn, redoBtn }

function registerModalUndo(id, extra) {
  const overlay = document.getElementById(id);
  if (!overlay || MODAL_UNDO.has(id)) return;
  const h = { extra: extra || null, stack: [], index: -1, timer: null, restoring: false };
  MODAL_UNDO.set(id, h);

  // 見出しに「戻す」「進む」を入れる(×ボタンの前)
  const head = overlay.querySelector(".modal-head");
  const tools = document.createElement("div");
  tools.className = "modal-undo";
  tools.innerHTML = `
    <button type="button" class="btn btn-ghost btn-sm" data-undo title="元に戻す（Ctrl+Z）">↶ 戻す</button>
    <button type="button" class="btn btn-ghost btn-sm" data-redo title="やり直す（Ctrl+Y）">↷ 進む</button>`;
  const close = head.querySelector(".modal-close");
  if (close) head.insertBefore(tools, close); else head.appendChild(tools);
  h.undoBtn = tools.querySelector("[data-undo]");
  h.redoBtn = tools.querySelector("[data-redo]");
  h.undoBtn.addEventListener("click", () => modalUndoStep(id, -1));
  h.redoBtn.addEventListener("click", () => modalUndoStep(id, +1));
  modalUndoButtons(h);

  const inHead = (el) => el.closest && el.closest(".modal-head");
  // 最初にさわる直前の状態を、出発点として覚える
  const baseline = (ev) => {
    if (h.restoring || inHead(ev.target) || h.stack.length) return;
    h.stack = [modalUndoCapture(overlay, h)];
    h.index = 0;
    modalUndoButtons(h);
  };
  overlay.addEventListener("pointerdown", baseline, true);
  overlay.addEventListener("focusin", baseline, true);
  overlay.addEventListener("keydown", baseline, true);
  // 文字の入力は、手が止まってから1回分として覚える
  overlay.addEventListener("input", (ev) => {
    if (h.restoring || inHead(ev.target)) return;
    clearTimeout(h.timer);
    h.timer = setTimeout(() => modalUndoRecord(overlay, h), 600);
  });
  overlay.addEventListener("change", (ev) => {
    if (h.restoring || inHead(ev.target)) return;
    modalUndoRecord(overlay, h);
  });
  // 行の追加・削除などのボタンは、押したあとの状態を覚える
  overlay.addEventListener("click", (ev) => {
    if (h.restoring || inHead(ev.target) || !ev.target.closest("button, .chip, label")) return;
    setTimeout(() => modalUndoRecord(overlay, h), 0);
  });
  // 閉じたら忘れる
  new MutationObserver(() => {
    if (!overlay.classList.contains("open")) {
      clearTimeout(h.timer);
      h.stack = [];
      h.index = -1;
      modalUndoButtons(h);
    }
  }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
}

// 覚える対象の入力欄
function modalUndoFields(overlay) {
  return [...overlay.querySelectorAll(".modal-body input, .modal-body select, .modal-body textarea, .modal-foot input")]
    .filter((el) => el.type !== "file" && el.type !== "hidden" && el.type !== "button")
    .map((el) => {
      if (el.id) return { key: "#" + el.id, el };
      if ((el.type === "radio" || el.type === "checkbox") && el.name) return { key: `${el.name}=${el.value}`, el };
      return null; // idも名前もない欄(明細の行など)は extra で扱う
    })
    .filter(Boolean);
}

function modalUndoCapture(overlay, h) {
  const fields = {};
  modalUndoFields(overlay).forEach(({ key, el }) => {
    fields[key] = el.type === "radio" || el.type === "checkbox" ? el.checked : el.value;
  });
  return JSON.stringify({ fields, extra: h.extra ? h.extra.get() : null });
}

function modalUndoRecord(overlay, h) {
  clearTimeout(h.timer);
  if (h.restoring || !overlay.classList.contains("open") || !h.stack.length) return;
  const snap = modalUndoCapture(overlay, h);
  if (snap === h.stack[h.index]) return;
  h.stack = h.stack.slice(0, h.index + 1); // 戻したあとに新しく入力したら、「進む」の分は捨てる
  h.stack.push(snap);
  if (h.stack.length > 100) h.stack.shift();
  h.index = h.stack.length - 1;
  modalUndoButtons(h);
}

function modalUndoStep(id, dir) {
  const overlay = document.getElementById(id);
  const h = MODAL_UNDO.get(id);
  if (!h || !overlay) return;
  modalUndoRecord(overlay, h); // 入力の途中(手が止まる前)の分も先に覚える
  const next = h.index + dir;
  if (next < 0 || next >= h.stack.length) return;
  h.index = next;
  const state = JSON.parse(h.stack[next]);
  h.restoring = true;
  try {
    if (h.extra) h.extra.set(JSON.parse(JSON.stringify(state.extra)));
    modalUndoFields(overlay).forEach(({ key, el }) => {
      if (!(key in state.fields)) return;
      const v = state.fields[key];
      if (el.type === "radio" || el.type === "checkbox") {
        if (el.checked === v) return;
        el.checked = v;
      } else {
        if (el.value === v) return;
        el.value = v;
      }
      // 画面の側の処理(表示の切り替えなど)も動かす
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } finally {
    h.restoring = false;
  }
  modalUndoButtons(h);
  toast(dir < 0 ? "1つ前に戻しました" : "やり直しました");
}

function modalUndoButtons(h) {
  h.undoBtn.disabled = h.index <= 0;
  h.redoBtn.disabled = h.index < 0 || h.index >= h.stack.length - 1;
}

document.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const k = ev.key.toLowerCase();
  const redo = k === "y" || (k === "z" && ev.shiftKey);
  if (k !== "z" && k !== "y") return;
  // 文字を入れている欄の中では、ブラウザのふつうの取り消しにまかせる
  const t = ev.target;
  if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && /^(text|number|search|tel|email|url)$/.test(t.type)))) return;
  const open = [...MODAL_UNDO.keys()].filter((id) => document.getElementById(id).classList.contains("open"));
  if (!open.length) return;
  ev.preventDefault();
  modalUndoStep(open[open.length - 1], redo ? +1 : -1);
});

// 開いたあとに中身を読み込むポップアップ(請求書など)で、読み込みが終わった時点を出発点にする
function modalUndoReset(id) {
  const h = MODAL_UNDO.get(id);
  if (!h) return;
  clearTimeout(h.timer);
  h.stack = [];
  h.index = -1;
  modalUndoButtons(h);
}
