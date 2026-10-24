// 玉ねぎ作業日報（staff.html の入力画面 / onion_reports.html のレポート・Excel出力）共通の定義と計算
//
// 日報データ（onion_reports.data）は1日1件で、出荷先ごとに blocks[0..2] を持つ。
//   blocks[i] = {
//     sign,                                   サイン（社員リストの呼び名）
//     sizeEntries: [{ size, packages: [{ type, count, kg?, unitKg? }] }],   使ったサイズ・荷姿
//     usedCount,                              つかったかず(kg)。sizeEntries から自動計算した値
//     timeRows: [{ start, end, people }],     時間と人数
//     producedRows: [{ date, container, kind, count, kg? }],      できたもの（使用日ごと）
//     todayCondition,                         きょうのようす
//     （旧形式：sizeColumns / producedColumns。2026-10-24より前の日報に残っている）
//   }

const ONION_BLOCK_TEMPLATES = [
  { destination: 'ベスト中国', colorClass: 'block-china',   sizeEditable: true,  sizeLabels: ['', '', ''],
    producedLabels: ['619', '615', '', ''], producedEditable: [false, false, true, true],
    producedContainers: ['619', '615'] },
  { destination: 'ベスト日本', colorClass: 'block-japan',   sizeEditable: false, sizeLabels: ['M', 'L', '-'],
    producedLabels: ['619', '615', '', ''], producedEditable: [false, false, true, true],
    producedContainers: ['619', '615'] },
  { destination: 'レインボー', colorClass: 'block-rainbow', sizeEditable: false, sizeLabels: ['M', 'L', '-'],
    producedLabels: ['村上', '', ''], producedEditable: [false, true, true],
    producedContainers: [] },  // 決まったコンテナなし（コンテナ名と重さを手入力）
];
// sizeEditable / sizeLabels / producedLabels / producedEditable は旧形式の日報をExcel出力するためだけに残している

// ── 使ったサイズ・荷姿 ──
// DB・ネット：1個の重さを 10kg／20kg から選び、重さ = 個数 × 1個の重さ（自動）
// 鉄コン・フレコン：既定重量がないため、その行の合計重さ(kg)を毎回手入力
const ONION_PACKAGES = ['DB', '鉄コン', 'フレコン', 'ネット'];
const ONION_MANUAL_WEIGHT_PACKAGES = ['鉄コン', 'フレコン'];
const ONION_PACKAGE_UNIT_OPTIONS = { 'DB': [10, 20], 'ネット': [10, 20] };
const ONION_DEFAULT_PACKAGE_UNIT_KG = 20;

// ── できたもの ──
// コンテナ1個あたりの重さ(kg)。ここにないコンテナ（レインボー・その他）は重さを手入力
const ONION_PRODUCED_UNIT_KG = { '619': 17, '615': 15 };
const ONION_PRODUCED_KINDS = ['通常', 'やり直し'];

const ONION_EFFICIENCY_TARGETS = { 'ベスト日本': 60, 'ベスト中国': 120, 'レインボー': 70 };

// 一覧表示の列順：ベスト日本・ベスト中国・レインボー（ONION_BLOCK_TEMPLATESの並びとは異なる）
const ONION_EXPORT_COLUMN_ORDER = [1, 0, 2];

function parseOnionNumber(text) {
  const m = String(text ?? '').match(/[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}

function roundKg(kg) {
  return Math.round(kg * 10) / 10;
}

// 荷姿1行の重さ(kg)。分からない場合（未入力・1個の重さが未選択）は null
function onionPackageKg(p) {
  if (ONION_MANUAL_WEIGHT_PACKAGES.includes(p.type)) {
    return p.kg === '' || p.kg == null ? null : parseFloat(p.kg);
  }
  const count = parseInt(p.count, 10) || 0;
  return p.unitKg == null ? null : count * p.unitKg;
}

// 戻り値：{ kg: 分かる分の合計kg, missingWeight: 重さが分からない荷姿が含まれるか }
function calcOnionUsedKg(sizeEntries) {
  let kg = 0;
  let missingWeight = false;
  (sizeEntries ?? []).forEach(e => (e.packages ?? []).forEach(p => {
    const w = onionPackageKg(p);
    if (w == null || isNaN(w)) { missingWeight = true; return; }
    kg += w;
  }));
  return { kg: roundKg(kg), missingWeight };
}

// できたもの1行の重さ(kg)。分からない場合は null
function onionProducedKg(row) {
  const unit = ONION_PRODUCED_UNIT_KG[row.container];
  if (unit != null) return (parseInt(row.count, 10) || 0) * unit;
  return row.kg === '' || row.kg == null ? null : parseFloat(row.kg);
}

// 戻り値：{ total, usual, byDate: { 'YYYY-MM-DD': kg }, missingWeight }
function calcOnionProducedKg(producedRows) {
  let total = 0;
  let usual = 0;
  let missingWeight = false;
  const byDate = {};
  (producedRows ?? []).forEach(r => {
    const w = onionProducedKg(r);
    if (w == null || isNaN(w)) { missingWeight = true; return; }
    total += w;
    if (r.kind === '通常') usual += w;
    byDate[r.date] = (byDate[r.date] ?? 0) + w;
  });
  Object.keys(byDate).forEach(d => { byDate[d] = roundKg(byDate[d]); });
  return { total: roundKg(total), usual: roundKg(usual), byDate, missingWeight };
}

function calcOnionPersonHours(block) {
  let total = 0;
  (block.timeRows ?? []).forEach(r => {
    if (!r.start || !r.end || !r.people) return;
    const [sh, sm] = r.start.split(':').map(Number);
    const [eh, em] = r.end.split(':').map(Number);
    const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
    const people = parseFloat(r.people) || 0;
    if (hours > 0 && people > 0) total += hours * people;
  });
  return total;
}

// 作業効率(kg/人時)
//   中国・日本：つかったかず(kg) / 人時
//   レインボー：できたもの（通常）の合計kg / 人時
function calcOnionEfficiency(bi, block) {
  const t = ONION_BLOCK_TEMPLATES[bi];
  const personHours = calcOnionPersonHours(block);
  if (personHours <= 0) return null;

  let amountKg;
  if (t.destination === 'レインボー') {
    amountKg = block.producedRows
      ? calcOnionProducedKg(block.producedRows).usual
      : (block.producedColumns ?? []).reduce((sum, c) => sum + parseOnionNumber(c.usual), 0);
  } else {
    amountKg = parseOnionNumber(block.usedCount);
  }
  if (amountKg <= 0) return null;

  const target = ONION_EFFICIENCY_TARGETS[t.destination];
  const efficiency = amountKg / personHours;
  return { destination: t.destination, efficiency, target, achieved: efficiency > target };
}

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
