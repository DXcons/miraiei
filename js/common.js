/* ==========================================================
   未来栄株式会社 図面管理システム(モック) 共通スクリプト
   ※ すべてダミーデータ・ダミー処理です(バックエンドなし)
   ========================================================== */

// ---------- ダミー図面データ ----------
// location: "outdoor" | "indoor"
// material: ["resin", "metal"] の部分集合
// parts: ["pulley","roller","belt","alignment","other"] の部分集合
const DRAWINGS = [
  { id: "D-2024-001", title: "屋外用ベルトコンベヤ標準図 A型", location: "outdoor", material: ["metal"], parts: ["pulley", "belt"], rollDiameter: 120, rollLength: 800, conveyorWidth: 650, conveyorLength: 5200, updatedAt: "2024-11-02" },
  { id: "D-2024-014", title: "室内搬送ローラーコンベヤ 樹脂ローラー仕様", location: "indoor", material: ["resin"], parts: ["roller"], rollDiameter: 60, rollLength: 500, conveyorWidth: 400, conveyorLength: 3000, updatedAt: "2024-12-18" },
  { id: "D-2025-002", title: "調芯ローラー付きベルトコンベヤ", location: "indoor", material: ["metal", "resin"], parts: ["roller", "belt", "alignment"], rollDiameter: 89, rollLength: 620, conveyorWidth: 500, conveyorLength: 4500, updatedAt: "2025-01-20" },
  { id: "D-2025-009", title: "屋外重量物用プーリーユニット", location: "outdoor", material: ["metal"], parts: ["pulley"], rollDiameter: 220, rollLength: 950, conveyorWidth: 800, conveyorLength: 8000, updatedAt: "2025-02-14" },
  { id: "D-2025-015", title: "小型室内搬送機 樹脂部品セット", location: "indoor", material: ["resin"], parts: ["pulley", "roller", "other"], rollDiameter: 45, rollLength: 300, conveyorWidth: 250, conveyorLength: 1800, updatedAt: "2025-03-05" },
  { id: "D-2025-021", title: "屋外設置型 蛇行防止調芯装置", location: "outdoor", material: ["metal"], parts: ["alignment"], rollDiameter: 100, rollLength: 700, conveyorWidth: 600, conveyorLength: 6000, updatedAt: "2025-04-11" },
  { id: "D-2025-030", title: "食品搬送用 樹脂ベルトコンベヤ", location: "indoor", material: ["resin"], parts: ["belt"], rollDiameter: 70, rollLength: 450, conveyorWidth: 350, conveyorLength: 2500, updatedAt: "2025-05-22" },
  { id: "D-2025-037", title: "屋外大型プーリー・ローラー複合ユニット", location: "outdoor", material: ["metal", "resin"], parts: ["pulley", "roller"], rollDiameter: 180, rollLength: 880, conveyorWidth: 700, conveyorLength: 7200, updatedAt: "2025-06-09" },
  { id: "D-2025-044", title: "室内軽搬送用その他付属部品図", location: "indoor", material: ["resin"], parts: ["other"], rollDiameter: 30, rollLength: 200, conveyorWidth: 200, conveyorLength: 1200, updatedAt: "2025-07-01" },
  { id: "D-2025-051", title: "屋外用調芯ローラー・ベルト標準セット", location: "outdoor", material: ["metal"], parts: ["roller", "belt", "alignment"], rollDiameter: 110, rollLength: 760, conveyorWidth: 620, conveyorLength: 5600, updatedAt: "2025-08-13" },
  { id: "D-2025-058", title: "室内クリーンルーム用樹脂コンベヤ一式", location: "indoor", material: ["resin"], parts: ["pulley", "belt"], rollDiameter: 55, rollLength: 400, conveyorWidth: 300, conveyorLength: 2000, updatedAt: "2025-09-02" },
  { id: "D-2025-063", title: "屋外標準プーリーユニット 金属製", location: "outdoor", material: ["metal"], parts: ["pulley"], rollDiameter: 150, rollLength: 820, conveyorWidth: 650, conveyorLength: 6400, updatedAt: "2025-10-17" },
];

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

// ---------- ログイン(ダミー認証) ----------
function mockLogin(id, password) {
  // モックのため、両方に何か入力されていればログイン成功とする
  if (id && password) {
    sessionStorage.setItem("miraiei_user", id);
    return true;
  }
  return false;
}

function requireLogin() {
  // モック用の簡易ガード。未ログインならログイン画面に戻す。
  if (!sessionStorage.getItem("miraiei_user")) {
    window.location.href = "login.html";
  }
}

function currentUserName() {
  return sessionStorage.getItem("miraiei_user") || "ゲスト";
}

function logout() {
  sessionStorage.removeItem("miraiei_user");
  window.location.href = "login.html";
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
