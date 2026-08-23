/**
 * tennis-analysis.js
 * ส่วนคำนวณล้วน ๆ ของเครื่องมือวิเคราะห์คลิปเทนนิส — ไม่แตะ DOM และไม่แตะ MediaPipe
 * เพื่อให้เทสได้ตรง ๆ ใน Node (ดู tennis-analysis.test.mjs)
 *
 * อินพุตคือ pose landmark ต่อเฟรมจาก MediaPipe PoseLandmarker
 * ใช้ worldLandmarks (พิกัด 3 มิติหน่วยเมตร อ้างอิงจุดกึ่งกลางสะโพก) เป็นหลัก
 * เพราะจัดการเรื่องระยะใกล้/ไกลกล้องกับ perspective ให้เองแล้ว
 *
 * แต่ละเฟรมมีรูปแบบ { t, world, image } โดย
 *   world = อาเรย์ของ {x,y,z} ตามดัชนี LM (จะใส่มาไม่ครบทุกดัชนีก็ได้ ขอแค่จุดที่ใช้)
 *   image = อาเรย์ของ {x,y,visibility} หรือ Float32Array แบบอัดแน่น 3 ค่าต่อจุด
 *           ใช้เฉพาะอ่านค่าความมั่นใจของ landmark เท่านั้น
 */

/** ดัชนี landmark ของ BlazePose ที่ใช้ */
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
};

/** ค่าตั้งต้นของเกณฑ์ตัดสิน ปรับได้จากหน้า UI */
export const DEFAULT_TUNING = {
  handed: 'right',       // มือถนัด: 'right' | 'left'
  sensitivity: 0.5,      // ความไวการจับ swing 0..1 (สูง = จับเยอะ)
  minGapSec: 0.45,       // ระยะห่างขั้นต่ำระหว่าง shot สองลูก (วินาที)
  minSpeed: 1.2,         // ความเร็วข้อมือขั้นต่ำที่ถือว่าเป็นสวิง (torso-unit/วินาที)
  maxPeakWidth: 0.32,    // ความกว้างสูงสุดของยอดความเร็วที่ครึ่งหนึ่งของยอด (วินาที)
  serveVert: 0.55,       // ข้อมือขึ้นเหนือแนวไหล่เท่านี้ (torso-unit) = เข้าข่ายเสิร์ฟ/สแมช
  serveElbow: 130,       // ...และต้องเหยียดศอกตรงเกินกี่องศา ถึงจะนับเป็นเสิร์ฟจริง
                         // ตั้งไว้กลางช่องว่างระหว่างศอกงอ (<90°) กับเสิร์ฟจริง (140-180°)
                         // เพราะมุมศอกช่วงใกล้เหยียดสุดไวต่อการสุ่มเฟรมมาก
                         // (คลาดไป 3 มิลลิวินาที มุมเปลี่ยนได้เกือบ 20 องศา)
  sideThr: 0.15,         // lateral ที่จุดกระทบเกินเท่านี้ = โฟร์แฮนด์
  sliceAngle: -3,        // มุมวิถีข้อมือต่ำกว่านี้ (องศา) = สไลซ์
  topspinAngle: 22,      // มุมวิถีข้อมือเกินนี้ = ท็อปสปิน
  topspinFollow: 0.30,   // ปลายสวิงจบสูงกว่าไหล่เท่านี้ = ท็อปสปิน
  topspinRise: 0.85,     // ยกจากจุดต่ำสุดก่อนกระทบมากกว่านี้ = ท็อปสปิน
};

export const SHOT_LABELS = {
  topspin: 'Topspin',
  flat: 'Flat',
  slice: 'Slice',
  serve: 'เสิร์ฟ/สแมช',
};

export const SIDE_LABELS = {
  fh: 'โฟร์แฮนด์',
  bh: 'แบ็คแฮนด์',
  na: '—',
};

/* ---------- เวกเตอร์ 3 มิติ ---------- */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const unit = (a) => {
  const n = len(a);
  return n < 1e-9 ? { x: 0, y: 0, z: 0 } : scale(a, 1 / n);
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * อ่านค่า visibility ของ landmark ลำดับ k
 * รองรับทั้งอาเรย์ของอ็อบเจกต์ และ Float32Array อัดแน่น (x, y, visibility ต่อจุด)
 */
export function visibilityOf(image, k) {
  if (!image) return 1;
  if (ArrayBuffer.isView(image)) {
    const i = k * 3 + 2;
    return i < image.length ? image[i] : 1;
  }
  const p = image[k];
  return p && typeof p.visibility === 'number' ? p.visibility : 1;
}

/** มุมที่จุด v ระหว่างแขน v→a และ v→b (องศา) */
function angleAt(v, a, b) {
  const u1 = unit(sub(a, v));
  const u2 = unit(sub(b, v));
  const c = clamp(dot(u1, u2), -1, 1);
  return (Math.acos(c) * 180) / Math.PI;
}

/** เปอร์เซ็นไทล์แบบ linear interpolation (คาดหวังอาเรย์ที่ยังไม่เรียง) */
export function percentile(values, p) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = clamp((a.length - 1) * p, 0, a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/* ---------- สร้าง time-series จาก pose ---------- */

/**
 * แปลง landmark ดิบเป็นพิกัดข้อมือใน "ระบบพิกัดของลำตัว" ที่ไม่ขึ้นกับมุมกล้อง
 *
 * @param {Array<{t:number, world:Array|null, image:Array|null}>} frames เรียงตามเวลา
 * @param {object} tuning
 * @returns {object} series
 */
export function buildSeries(frames, tuning = {}) {
  const cfg = { ...DEFAULT_TUNING, ...tuning };
  const handSign = cfg.handed === 'left' ? -1 : 1;
  const wristIdx = cfg.handed === 'left' ? LM.L_WRIST : LM.R_WRIST;
  const elbowIdx = cfg.handed === 'left' ? LM.L_ELBOW : LM.R_ELBOW;
  const shoulderIdx = cfg.handed === 'left' ? LM.L_SHOULDER : LM.R_SHOULDER;
  const n = frames.length;

  const t = new Float64Array(n);
  const lat = new Float64Array(n).fill(NaN);   // + = ฝั่งมือถนัด
  const vert = new Float64Array(n).fill(NaN);  // + = สูงกว่าแนวไหล่
  const dep = new Float64Array(n).fill(NaN);   // + = ไปทางด้านหน้าลำตัว
  const torso = new Float64Array(n).fill(NaN); // ความยาวไหล่-สะโพก (เมตร)
  const elbow = new Float64Array(n).fill(NaN); // มุมข้อศอกแขนข้างที่ถนัด (องศา)
  const vis = new Float64Array(n).fill(0);     // ความมั่นใจของ landmark ลำตัว
  const raw = new Uint8Array(n);               // 1 = เฟรมนี้ตรวจเจอ pose จริง

  for (let i = 0; i < n; i++) {
    t[i] = frames[i].t;
    const w = frames[i].world;
    if (!w || w.length <= LM.R_HIP) continue;

    const mS = mid(w[LM.L_SHOULDER], w[LM.R_SHOULDER]);
    const mH = mid(w[LM.L_HIP], w[LM.R_HIP]);
    const torsoVec = sub(mS, mH);
    const shoulderVec = sub(w[LM.R_SHOULDER], w[LM.L_SHOULDER]);
    // ใช้ความยาวไหล่เป็นตัวสำรองเผื่อลำตัวถูกย่อจากมุมกล้อง
    const tl = Math.max(len(torsoVec), len(shoulderVec) * 0.9, 1e-3);

    const up = unit(torsoVec);
    // ทำให้แกน "ขวาของนักกีฬา" ตั้งฉากกับแกนขึ้น
    let right = sub(shoulderVec, scale(up, dot(shoulderVec, up)));
    right = unit(right);
    const fwd = unit(cross(right, up));

    const d = sub(w[wristIdx], mS);
    lat[i] = (dot(d, right) / tl) * handSign;
    vert[i] = dot(d, up) / tl;
    dep[i] = dot(d, fwd) / tl;
    torso[i] = tl;
    elbow[i] = angleAt(w[elbowIdx], w[shoulderIdx], w[wristIdx]);
    raw[i] = 1;

    const img = frames[i].image;
    if (img) {
      const pts = [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP, wristIdx];
      let m = 1;
      for (const k of pts) {
        const v = visibilityOf(img, k);
        if (v < m) m = v;
      }
      vis[i] = m;
    } else {
      vis[i] = 1;
    }
  }

  const fps = estimateSeriesFps(t);
  const maxGap = Math.max(1, Math.round(fps * 0.2)); // เติมช่องว่างได้ไม่เกิน 0.2 วินาที
  const valid = fillGaps([lat, vert, dep, torso, vis, elbow], raw, maxGap);

  // เกลี่ยสัญญาณราว 50 มิลลิวินาที: พอกลบ jitter ของ landmark แต่ไม่ทู่ยอดสวิงที่คมมาก
  const win = clamp(Math.round(fps * 0.05) | 1, 3, 9);
  const latS = smooth(lat, valid, win);
  const vertS = smooth(vert, valid, win);
  const depS = smooth(dep, valid, win);
  const speed = wristSpeed(t, latS, vertS, depS, valid);

  return {
    n, fps, t,
    lat: latS, vert: vertS, dep: depS,
    torso, elbow, vis, valid, speed,
    detected: raw.reduce((s, v) => s + v, 0),
    handed: cfg.handed,
  };
}

/** ประมาณ fps จากค่ามัธยฐานของช่วงเวลาระหว่างเฟรม */
export function estimateSeriesFps(t) {
  if (t.length < 3) return 30;
  const d = [];
  for (let i = 1; i < t.length; i++) {
    const dt = t[i] - t[i - 1];
    if (dt > 1e-4) d.push(dt);
  }
  if (!d.length) return 30;
  const m = percentile(d, 0.5);
  return m > 1e-4 ? clamp(1 / m, 1, 480) : 30;
}

/** เติมช่องว่างสั้น ๆ ด้วยการ interpolate เชิงเส้น คืน mask ของเฟรมที่ใช้ได้ */
function fillGaps(arrays, raw, maxGap) {
  const n = raw.length;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = raw[i];

  let i = 0;
  while (i < n) {
    if (raw[i]) { i++; continue; }
    const start = i;
    while (i < n && !raw[i]) i++;
    const gap = i - start;
    const hasBoth = start > 0 && i < n;
    if (hasBoth && gap <= maxGap) {
      for (const arr of arrays) {
        const a = arr[start - 1], b = arr[i];
        for (let k = 0; k < gap; k++) arr[start + k] = a + ((b - a) * (k + 1)) / (gap + 1);
      }
      for (let k = 0; k < gap; k++) valid[start + k] = 1;
    }
  }
  return valid;
}

/** ค่าเฉลี่ยเคลื่อนที่แบบมีศูนย์กลาง ข้ามเฟรมที่ใช้ไม่ได้ */
function smooth(arr, valid, win) {
  const n = arr.length;
  const out = new Float64Array(n).fill(NaN);
  const half = (win - 1) >> 1;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    let sum = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= n || !valid[j]) continue;
      sum += arr[j]; cnt++;
    }
    out[i] = cnt ? sum / cnt : arr[i];
  }
  return out;
}

/** ความเร็วข้อมือ (torso-unit ต่อวินาที) จาก central difference */
function wristSpeed(t, lat, vert, dep, valid) {
  const n = t.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (!valid[i - 1] || !valid[i] || !valid[i + 1]) continue;
    const dt = t[i + 1] - t[i - 1];
    if (dt <= 1e-6) continue;
    const dx = lat[i + 1] - lat[i - 1];
    const dy = vert[i + 1] - vert[i - 1];
    const dz = dep[i + 1] - dep[i - 1];
    out[i] = Math.hypot(dx, dy, dz) / dt;
  }
  return out;
}

/* ---------- จับจังหวะตี ---------- */

/**
 * หา peak ของความเร็วข้อมือแล้วกรองด้วยระยะห่างขั้นต่ำ
 * @returns {number[]} ดัชนีเฟรมของจุดกระทบ เรียงตามเวลา
 */
export function detectShots(series, tuning = {}) {
  const cfg = { ...DEFAULT_TUNING, ...tuning };
  const { speed, t, valid, n } = series;

  const thr = shotThreshold(series, cfg);
  if (!Number.isFinite(thr)) return [];

  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (!valid[i] || speed[i] < thr) continue;
    if (speed[i] < speed[i - 1] || speed[i] <= speed[i + 1]) continue;
    // ยอดความเร็วของสวิงจริงจะ "คม" (เร่งแล้วชะลอภายในเสี้ยววินาที)
    // ส่วนการวิ่งเข้าที่หรือชักแร็กเก็ตกลับจะเป็นเนินกว้าง ๆ จึงคัดออกด้วยความกว้างของยอด
    if (peakWidth(series, i, cfg.maxPeakWidth) > cfg.maxPeakWidth) continue;
    peaks.push(i);
  }

  // non-max suppression: เก็บ peak ที่แรงที่สุดก่อน แล้วตัดตัวที่อยู่ใกล้เกินไป
  peaks.sort((a, b) => speed[b] - speed[a]);
  const kept = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.abs(t[p] - t[q]) >= cfg.minGapSec)) kept.push(p);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

/**
 * เกณฑ์ความเร็วขั้นต่ำที่ใช้ตัดสินว่าเป็นสวิง
 * อิงเปอร์เซ็นไทล์ที่ 95 ของคลิปนั้น ๆ เพื่อให้ปรับตามความแรงของผู้เล่นเอง
 */
export function shotThreshold(series, tuning = {}) {
  const cfg = { ...DEFAULT_TUNING, ...tuning };
  const pool = [];
  for (let i = 0; i < series.n; i++) {
    if (series.valid[i] && series.speed[i] > 0) pool.push(series.speed[i]);
  }
  if (pool.length < 3) return Infinity;
  const p95 = percentile(pool, 0.95);
  return Math.max(cfg.minSpeed, p95 * (0.55 - 0.35 * clamp(cfg.sensitivity, 0, 1)));
}

/**
 * ความกว้างของยอดความเร็วที่ระดับครึ่งหนึ่งของยอด (วินาที)
 * ถ้าความเร็วไม่ยอมตกลงมาถึงครึ่งหนึ่งภายในระยะที่ค้นหา จะคืนค่าที่มากกว่าขีดจำกัดเสมอ
 */
export function peakWidth(series, i, maxSearch) {
  const { speed, t, valid, n } = series;
  const half = speed[i] * 0.5;
  let l = i;
  while (l > 0 && t[i] - t[l - 1] <= maxSearch && valid[l - 1] && speed[l - 1] > half) l--;
  let r = i;
  while (r < n - 1 && t[r + 1] - t[i] <= maxSearch && valid[r + 1] && speed[r + 1] > half) r++;
  const dropsLeft = l > 0 && valid[l - 1] && speed[l - 1] <= half;
  const dropsRight = r < n - 1 && valid[r + 1] && speed[r + 1] <= half;
  if (!dropsLeft || !dropsRight) return Infinity;
  return t[r] - t[l];
}

/* ---------- แยกชนิดลูก ---------- */

/**
 * ช่วงเวลา "เหวี่ยงเข้าหาลูก" เทียบกับยอดความเร็ว
 * ยอดความเร็วข้อมือไม่ตรงกับจุดกระทบเป๊ะ ๆ — เลื่อนได้ทั้งก่อนและหลังตามรูปสวิง
 * หน้าต่างนี้จึงกว้างพอจะครอบจังหวะปะทะจริง แต่ยังไม่กินไปถึงปลาย follow-through
 */
const HIT_BACK = 0.15;
const HIT_FWD = 0.12;

/** ค่าที่มีขนาดสัมบูรณ์มากที่สุดของ arr ในช่วงเวลาที่กำหนด */
function extremeIn(series, arr, tFrom, tTo) {
  const a = Math.max(0, indexAt(series, tFrom));
  const b = Math.min(series.n - 1, indexAt(series, tTo));
  let best = NaN, bestIdx = -1;
  for (let i = a; i <= b; i++) {
    if (!series.valid[i] || !Number.isFinite(arr[i])) continue;
    if (bestIdx < 0 || Math.abs(arr[i]) > Math.abs(best)) { best = arr[i]; bestIdx = i; }
  }
  return { value: best, index: bestIdx };
}

/** ค่าสูงสุด (มีเครื่องหมาย) ของ arr ในช่วงเวลาที่กำหนด */
function maxIn(series, arr, tFrom, tTo) {
  const a = Math.max(0, indexAt(series, tFrom));
  const b = Math.min(series.n - 1, indexAt(series, tTo));
  let best = NaN, bestIdx = -1;
  for (let i = a; i <= b; i++) {
    if (!series.valid[i] || !Number.isFinite(arr[i])) continue;
    if (bestIdx < 0 || arr[i] > best) { best = arr[i]; bestIdx = i; }
  }
  return { value: best, index: bestIdx };
}

/** หาเฟรมที่ใกล้เวลาที่ต้องการที่สุด */
export function indexAt(series, time) {
  const { t, n } = series;
  if (n === 0) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < time) lo = m + 1; else hi = m;
  }
  if (lo > 0 && Math.abs(t[lo - 1] - time) <= Math.abs(t[lo] - time)) return lo - 1;
  return lo;
}

const at = (series, arr, time) => {
  const i = indexAt(series, time);
  return i >= 0 && series.valid[i] ? arr[i] : NaN;
};

/**
 * แยกชนิดลูกจากรูปร่างของวิถีข้อมือรอบจุดกระทบ
 * คืนทั้งผลตัดสินและฟีเจอร์ดิบ เพื่อเอาไป export เป็นชุดข้อมูลเทรนต่อได้
 */
export function classifyShot(series, peakIdx, tuning = {}) {
  const cfg = { ...DEFAULT_TUNING, ...tuning };
  const { t, lat, vert, dep, speed, elbow, vis, valid } = series;
  const t0 = t[peakIdx];
  const hitFrom = t0 - HIT_BACK;
  const hitTo = t0 + HIT_FWD;

  // วิถีข้อมือช่วง ±0.12 วินาทีรอบยอดความเร็ว บอกว่าแร็กเก็ตวิ่งขึ้นหรือลงผ่านลูก
  const w = 0.12;
  const dLat = at(series, lat, t0 + w) - at(series, lat, t0 - w);
  const dVert = at(series, vert, t0 + w) - at(series, vert, t0 - w);
  const dDep = at(series, dep, t0 + w) - at(series, dep, t0 - w);
  const horiz = Math.hypot(dLat || 0, dDep || 0);
  const pathAngle = Number.isFinite(dVert) ? (Math.atan2(dVert, horiz) * 180) / Math.PI : 0;

  // ตำแหน่งด้านข้างสุดขั้วระหว่างเหวี่ยงเข้าหาลูก ใช้บอกฝั่ง FH/BH
  // (ค่า ณ ยอดความเร็วอย่างเดียวไม่พอ เพราะข้อมืออาจข้ามลำตัวไปแล้ว)
  const latSwing = extremeIn(series, lat, hitFrom, hitTo).value || 0;

  // จุดสูงสุดของข้อมือ และการเหยียดศอกมากที่สุด ระหว่างช่วงเหวี่ยง
  // ใช้คู่กันเพื่อแยกเสิร์ฟ/สแมชออกจากลูกกราวด์สโตรก
  // (อ่านมุมศอกจากเฟรมเดียวไม่ได้ เพราะมุมศอกเปลี่ยนเร็วมากรอบจุดสูงสุด
  //  ต่างกันแค่เฟรมเดียวก็เพี้ยนไปหลายสิบองศา)
  const vertTopRaw = maxIn(series, vert, hitFrom, hitTo).value;
  const vertTop = Number.isFinite(vertTopRaw) ? vertTopRaw : 0;
  const elbowRaw = maxIn(series, elbow, hitFrom, hitTo).value;
  const elbowMax = Number.isFinite(elbowRaw) ? elbowRaw : 0;
  const vertContact = Number.isFinite(vert[peakIdx]) ? vert[peakIdx] : 0;

  // จุดต่ำสุดของข้อมือใน 0.45 วินาทีก่อนยอดความเร็ว = จังหวะ racket drop
  let dropVert = vertContact;
  const iStart = Math.max(0, indexAt(series, t0 - 0.45));
  for (let i = iStart; i <= peakIdx; i++) {
    if (valid[i] && Number.isFinite(vert[i]) && vert[i] < dropVert) dropVert = vert[i];
  }
  const riseFromDrop = vertContact - dropVert;

  const followRaw = at(series, vert, t0 + 0.35);
  const followVert = Number.isFinite(followRaw) ? followRaw : vertContact;

  const visContact = Number.isFinite(vis[peakIdx]) ? vis[peakIdx] : 0;
  const features = {
    pathAngle, latSwing, vertContact, vertTop, elbowMax,
    riseFromDrop, followVert,
    peakSpeed: speed[peakIdx] || 0, visibility: visContact,
  };

  // เสิร์ฟ/สแมช: ข้อมือขึ้นเหนือแนวไหล่มากพร้อมกับเหยียดศอกตรง
  // เงื่อนไขศอกช่วยกันไม่ให้จังหวะเตรียมแบ็คแฮนด์สูง ๆ ถูกอ่านเป็นเสิร์ฟ
  if (vertTop > cfg.serveVert && elbowMax > cfg.serveElbow) {
    return {
      type: 'serve', side: 'na',
      sideConf: 0,
      typeConf: clamp((vertTop - cfg.serveVert) / 0.35, 0.35, 0.95) * clamp(visContact, 0.3, 1),
      features,
    };
  }

  const side = latSwing > cfg.sideThr ? 'fh' : 'bh';
  const sideConf = clamp(Math.abs(latSwing - cfg.sideThr) / 0.35, 0.15, 1) * clamp(visContact, 0.3, 1);

  let type, margin;
  if (pathAngle < cfg.sliceAngle && followVert < 0.30) {
    type = 'slice';
    margin = Math.min((cfg.sliceAngle - pathAngle) / 12, (0.30 - followVert) / 0.25);
  } else if (pathAngle > cfg.topspinAngle || followVert > cfg.topspinFollow || riseFromDrop > cfg.topspinRise) {
    type = 'topspin';
    margin = Math.max(
      (pathAngle - cfg.topspinAngle) / 20,
      (followVert - cfg.topspinFollow) / 0.30,
      (riseFromDrop - cfg.topspinRise) / 0.50,
    );
  } else {
    type = 'flat';
    margin = Math.min(
      (cfg.topspinAngle - pathAngle) / 20,
      (pathAngle - cfg.sliceAngle) / 12,
      (cfg.topspinFollow - followVert) / 0.30,
    );
  }

  // flat กับ topspin แยกจาก pose อย่างเดียวไม่ชัวร์ จึงกดเพดานความมั่นใจไว้ตามความเป็นจริง
  const ceiling = type === 'slice' ? 0.9 : 0.7;
  const typeConf = clamp(0.35 + clamp(margin, 0, 1) * 0.55, 0.2, ceiling) * clamp(visContact, 0.3, 1);

  return { type, side, sideConf, typeConf, features };
}

/** วิเคราะห์ทั้งคลิปในครั้งเดียว: สร้าง series → หา peak → แยกชนิดลูก */
export function analyze(frames, tuning = {}) {
  const cfg = { ...DEFAULT_TUNING, ...tuning };
  const series = buildSeries(frames, cfg);
  const peaks = detectShots(series, cfg);
  const shots = peaks.map((idx, i) => ({
    no: i + 1,
    frameIndex: idx,
    time: series.t[idx],
    manual: false,
    userType: null,
    userSide: null,
    ...classifyShot(series, idx, cfg),
  }));
  return { series, shots };
}

/** นับสรุปตามชนิดลูกและฝั่ง โดยให้ label ที่ผู้ใช้แก้เองมาก่อนผลของโมเดล */
export function summarize(shots) {
  const s = {
    total: shots.length,
    topspin: 0, flat: 0, slice: 0, serve: 0,
    fh: 0, bh: 0,
    corrected: 0,
  };
  for (const sh of shots) {
    const type = sh.userType || sh.type;
    const side = sh.userSide || sh.side;
    if (type in s) s[type]++;
    if (side === 'fh') s.fh++;
    else if (side === 'bh') s.bh++;
    if (sh.userType || sh.userSide) s.corrected++;
  }
  return s;
}

/** แปลงผลเป็น CSV สำหรับเอาไปทำชุดข้อมูลเทรนโมเดลรุ่นถัดไป */
export function shotsToCsv(shots) {
  const head = [
    'no', 'time_sec', 'type_model', 'type_label', 'side_model', 'side_label',
    'type_conf', 'side_conf', 'path_angle_deg', 'lat_swing', 'vert_contact',
    'vert_top', 'elbow_max_deg', 'rise_from_drop', 'follow_vert',
    'peak_speed', 'visibility', 'manual',
  ];
  const rows = shots.map((s) => [
    s.no,
    s.time.toFixed(3),
    s.type,
    s.userType || '',
    s.side,
    s.userSide || '',
    s.typeConf.toFixed(3),
    s.sideConf.toFixed(3),
    s.features.pathAngle.toFixed(2),
    s.features.latSwing.toFixed(4),
    s.features.vertContact.toFixed(4),
    s.features.vertTop.toFixed(4),
    s.features.elbowMax.toFixed(1),
    s.features.riseFromDrop.toFixed(4),
    s.features.followVert.toFixed(4),
    s.features.peakSpeed.toFixed(4),
    s.features.visibility.toFixed(3),
    s.manual ? '1' : '0',
  ]);
  return [head, ...rows].map((r) => r.join(',')).join('\n');
}
