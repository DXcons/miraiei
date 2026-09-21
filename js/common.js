/* ==========================================================
   未来栄株式会社 図面管理システム(モック) 共通スクリプト
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
    await auth.signInWithEmailAndPassword(email, password);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// ログイン必須ページの先頭で呼ぶ。未ログインならログイン画面へ飛ばしてfalseを返す。
async function requireLogin() {
  const user = await waitForAuthUser();
  if (!user) {
    window.location.href = "login.html";
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
