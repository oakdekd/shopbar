/**
 * เทสส่วนคำนวณด้วย pose สังเคราะห์ที่จำลองรูปร่างสวิงจริง
 * รันด้วย: node --test tennis-analysis.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, buildSeries, detectShots, estimateSeriesFps,
  percentile, summarize, shotsToCsv, indexAt, DEFAULT_TUNING,
} from '../tennis-analysis.js';

const TORSO = 0.5;
const UPPER_ARM = 0.28; // ต้นแขน (เมตร)
const FOREARM = 0.26;   // ปลายแขน (เมตร)

/**
 * วางข้อศอกด้วย inverse kinematics จากไหล่และข้อมือ
 * มุมศอกจึงถูกกำหนดโดยระยะไหล่-ข้อมือตามจริง ไม่ใช่ค่าที่ตั้งเอง
 */
function placeElbow(S, W) {
  const d = { x: W.x - S.x, y: W.y - S.y, z: W.z - S.z };
  const L = Math.max(Math.hypot(d.x, d.y, d.z), 1e-6);
  const reach = Math.min(L, UPPER_ARM + FOREARM - 1e-4);
  const k = reach / L;
  const dh = { x: (d.x * k) / reach, y: (d.y * k) / reach, z: (d.z * k) / reach };
  const u = (reach * reach + UPPER_ARM * UPPER_ARM - FOREARM * FOREARM) / (2 * reach);
  const v = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - u * u));
  // ทิศที่ศอกห้อยออกไป: ลงล่างและถอยหลังเล็กน้อย (ไม่มีผลต่อมุมศอก)
  let ref = { x: 0, y: 1, z: 0.3 };
  const proj = ref.x * dh.x + ref.y * dh.y + ref.z * dh.z;
  let pp = { x: ref.x - proj * dh.x, y: ref.y - proj * dh.y, z: ref.z - proj * dh.z };
  let pn = Math.hypot(pp.x, pp.y, pp.z);
  if (pn < 1e-6) {
    ref = { x: 1, y: 0, z: 0 };
    const p2 = ref.x * dh.x + ref.y * dh.y + ref.z * dh.z;
    pp = { x: ref.x - p2 * dh.x, y: ref.y - p2 * dh.y, z: ref.z - p2 * dh.z };
    pn = Math.hypot(pp.x, pp.y, pp.z) || 1;
  }
  return {
    x: S.x + dh.x * u + (pp.x / pn) * v,
    y: S.y + dh.y * u + (pp.y / pn) * v,
    z: S.z + dh.z * u + (pp.z / pn) * v,
    visibility: 1,
  };
}

/**
 * สร้าง worldLandmark ครบ 33 จุดจากตำแหน่งข้อมือใน body frame
 * handed = 'left' หมายถึงใช้ข้อมือซ้าย (index 15) และสวิงอยู่ฝั่งซ้ายของลำตัว
 * ลำตัวไม่ถูกสลับข้าง เพราะป้าย L/R ของ landmark ยึดตามตัวนักกีฬาเสมอ
 */
function makeWorld({ lat, vert, dep }, handed = 'right') {
  const wristIdx = handed === 'left' ? 15 : 16;
  const sign = handed === 'left' ? -1 : 1;
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  pts[11] = { x: -0.18, y: -0.50, z: 0, visibility: 1 }; // ไหล่ซ้าย
  pts[12] = { x: 0.18, y: -0.50, z: 0, visibility: 1 };  // ไหล่ขวา
  pts[23] = { x: -0.12, y: 0, z: 0, visibility: 1 };     // สะโพกซ้าย
  pts[24] = { x: 0.12, y: 0, z: 0, visibility: 1 };      // สะโพกขวา
  pts[0] = { x: 0, y: -0.72, z: 0, visibility: 1 };      // จมูก
  // แกน: right=(1,0,0) up=(0,-1,0) fwd=(0,0,-1) จุดอ้างอิง = กึ่งกลางไหล่
  pts[wristIdx] = {
    x: sign * lat * TORSO,
    y: -0.5 - vert * TORSO,
    z: -dep * TORSO,
    visibility: 1,
  };
  const shoulderIdx = handed === 'left' ? 11 : 12;
  const elbowIdx = handed === 'left' ? 13 : 14;
  pts[elbowIdx] = placeElbow(pts[shoulderIdx], pts[wristIdx]);
  return pts;
}

const REST = { lat: 0.35, vert: -0.75, dep: 0.25 };
const lerp = (a, b, u) => ({
  lat: a.lat + (b.lat - a.lat) * u,
  vert: a.vert + (b.vert - a.vert) * u,
  dep: a.dep + (b.dep - a.dep) * u,
});
const smoothstep = (u) => u * u * (3 - 2 * u);

/** รูปร่างสวิงจริง ๆ ของแต่ละชนิดลูก (หน่วย torso-unit) */
const STROKES = {
  topspin: { start: { lat: 0.70, vert: -0.55, dep: 0.10 }, contact: { lat: 0.75, vert: -0.05, dep: 0.60 }, end: { lat: -0.20, vert: 0.45, dep: 0.50 } },
  flat:    { start: { lat: 0.85, vert: -0.15, dep: 0.15 }, contact: { lat: 0.80, vert: 0.00, dep: 0.65 }, end: { lat: 0.30, vert: 0.12, dep: 1.00 } },
  slice:   { start: { lat: -0.35, vert: 0.35, dep: 0.30 }, contact: { lat: -0.45, vert: -0.10, dep: 0.65 }, end: { lat: -0.55, vert: -0.30, dep: 0.90 } },
  highvolley: { start: { lat: 0.30, vert: -0.10, dep: 0.20 }, contact: { lat: 0.25, vert: 0.75, dep: 0.15 }, end: { lat: 0.20, vert: 0.30, dep: 0.45 } },
  serve:   { start: { lat: 0.20, vert: -0.50, dep: 0.10 }, contact: { lat: 0.35, vert: 1.00, dep: 0.35 }, end: { lat: -0.40, vert: -0.40, dep: 0.70 } },
};

/** ตำแหน่งข้อมือระหว่างสวิง: sigmoid ทำให้ความเร็วสูงสุดพอดีที่จุดกระทบ */
function swingAt(stroke, tau, sigma = 0.10) {
  const g = 0.5 * (1 + Math.tanh(tau / sigma));
  return g < 0.5
    ? lerp(stroke.start, stroke.contact, g * 2)
    : lerp(stroke.contact, stroke.end, (g - 0.5) * 2);
}

const SWING_HALF = 0.5; // ช่วงเวลาที่ถือว่ากำลังสวิงอยู่ (วินาทีต่อข้าง)

/**
 * สร้างคลิปสังเคราะห์
 * @param {Array<{t:number, kind:string}>} plan รายการช็อตที่ต้องการ
 */
function makeClip(plan, { fps = 60, duration = null, dropFrom = null, dropTo = null, handed = 'right' } = {}) {
  const last = plan[plan.length - 1];
  const total = duration ?? last.t + 1.5;
  const frames = [];
  for (let i = 0; i * (1 / fps) <= total; i++) {
    const t = i / fps;
    let pos = null;
    for (const s of plan) {
      const tau = t - s.t;
      if (Math.abs(tau) <= SWING_HALF) { pos = swingAt(STROKES[s.kind], tau); break; }
    }
    if (!pos) {
      // ระหว่างช็อต: เคลื่อนกลับจุดพักอย่างช้า ๆ ไม่ให้เกิด peak ปลอม
      const prev = [...plan].reverse().find((s) => t > s.t + SWING_HALF);
      const next = plan.find((s) => t < s.t - SWING_HALF);
      const from = prev ? STROKES[prev.kind].end : REST;
      const to = next ? STROKES[next.kind].start : REST;
      const a = prev ? prev.t + SWING_HALF : 0;
      const b = next ? next.t - SWING_HALF : total;
      const u = b > a ? smoothstep(Math.min(1, Math.max(0, (t - a) / (b - a)))) : 1;
      pos = lerp(from, to, u);
    }
    const dropped = dropFrom !== null && t >= dropFrom && t <= dropTo;
    const world = dropped ? null : makeWorld(pos, handed);
    frames.push({ t, world, image: world });
  }
  return frames;
}

test('ประมาณ fps จาก timestamp ได้ถูกต้อง', () => {
  const t = Array.from({ length: 100 }, (_, i) => i / 59.94);
  assert.ok(Math.abs(estimateSeriesFps(t) - 59.94) < 0.5);
});

test('percentile คำนวณตรงตามคาด', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 0.5), 5.5);
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile(v, 1), 10);
  assert.equal(percentile([], 0.5), 0);
});

test('indexAt คืนเฟรมที่ใกล้เวลาที่สุด', () => {
  const series = { t: [0, 0.1, 0.2, 0.3], n: 4 };
  assert.equal(indexAt(series, 0.0), 0);
  assert.equal(indexAt(series, 0.14), 1);
  assert.equal(indexAt(series, 0.16), 2);
  assert.equal(indexAt(series, 99), 3);
});

test('นับจำนวน swing ได้ครบตามที่ใส่เข้าไป', () => {
  const plan = [
    { t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' },
    { t: 4.2, kind: 'flat' }, { t: 5.8, kind: 'topspin' },
    { t: 7.4, kind: 'slice' }, { t: 9.0, kind: 'flat' },
  ];
  const { shots } = analyze(makeClip(plan));
  assert.equal(shots.length, plan.length, `คาด ${plan.length} ช็อต แต่ได้ ${shots.length}`);
  shots.forEach((s, i) => {
    assert.ok(Math.abs(s.time - plan[i].t) < 0.06, `ช็อต ${i + 1} เวลาเพี้ยน ${s.time} vs ${plan[i].t}`);
  });
});

test('แยกชนิดลูกและฝั่งได้ตรงกับรูปร่างสวิงที่ป้อนเข้าไป', () => {
  const plan = [
    { t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'flat' },
    { t: 4.2, kind: 'slice' }, { t: 5.8, kind: 'serve' },
  ];
  const { shots } = analyze(makeClip(plan));
  assert.equal(shots.length, 4);
  assert.deepEqual(shots.map((s) => s.type), ['topspin', 'flat', 'slice', 'serve']);
  // topspin/flat จำลองเป็นโฟร์แฮนด์ slice เป็นแบ็คแฮนด์ เสิร์ฟไม่แยกฝั่ง
  assert.deepEqual(shots.map((s) => s.side), ['fh', 'fh', 'bh', 'na']);
  // ทิศของวิถีข้อมือต้องสอดคล้องกับชนิดลูก
  assert.ok(shots[0].features.pathAngle > 22, `topspin ควรวิถีชันขึ้น ได้ ${shots[0].features.pathAngle}`);
  assert.ok(shots[2].features.pathAngle < -3, `slice ควรวิถีลง ได้ ${shots[2].features.pathAngle}`);
  // ความมั่นใจ flat/topspin ต้องถูกกดเพดานไว้ต่ำกว่า slice ตามข้อจำกัดจริง
  assert.ok(shots[0].typeConf <= 0.7 && shots[1].typeConf <= 0.7);
});

test('มือซ้าย: โฟร์แฮนด์/แบ็คแฮนด์ต้องสลับข้างให้ถูก', () => {
  const plan = [{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }];
  const { shots } = analyze(makeClip(plan, { handed: 'left' }), { handed: 'left' });
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map((s) => s.side), ['fh', 'bh']);
});

test('เฟรมที่ตรวจไม่เจอ pose สั้น ๆ ถูกเติมค่าให้ ไม่ทำให้ช็อตหาย', () => {
  const plan = [{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'flat' }, { t: 4.2, kind: 'slice' }];
  // ตัด pose หายไป 0.1 วินาที ในช่วงที่ไม่ได้ตี
  const frames = makeClip(plan, { dropFrom: 3.3, dropTo: 3.4 });
  const series = buildSeries(frames);
  assert.ok(series.detected < frames.length, 'ต้องมีเฟรมที่ตรวจไม่เจอจริง');
  const filled = Array.from(series.valid).filter(Boolean).length;
  assert.equal(filled, frames.length, 'ช่องว่างสั้นต้องถูกเติมจนครบ');
  assert.equal(detectShots(series).length, 3);
});

test('เฟรมที่หายยาวเกิน 0.2 วินาที ไม่ถูกเติมค่ามั่ว', () => {
  const plan = [{ t: 1.0, kind: 'topspin' }, { t: 3.5, kind: 'flat' }];
  const frames = makeClip(plan, { dropFrom: 2.0, dropTo: 2.6 });
  const series = buildSeries(frames);
  const invalid = Array.from(series.valid).filter((v) => !v).length;
  assert.ok(invalid > 20, `ช่องว่างยาวต้องถูกทำเป็น invalid ได้ ${invalid}`);
});

test('ความไวสูงขึ้นต้องจับ swing ได้ไม่น้อยลง', () => {
  const plan = [
    { t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }, { t: 4.2, kind: 'flat' },
  ];
  const series = buildSeries(makeClip(plan));
  const low = detectShots(series, { sensitivity: 0 }).length;
  const high = detectShots(series, { sensitivity: 1 }).length;
  assert.ok(high >= low, `ความไวสูงควรจับได้ไม่น้อยกว่า (${high} vs ${low})`);
});

test('ไม่มีคนในเฟรมเลย ต้องไม่พังและคืนศูนย์ช็อต', () => {
  const frames = Array.from({ length: 120 }, (_, i) => ({ t: i / 60, world: null, image: null }));
  const { series, shots } = analyze(frames);
  assert.equal(shots.length, 0);
  assert.equal(series.detected, 0);
});

test('summarize ให้ label ที่ผู้ใช้แก้เองมาก่อนผลของโมเดล', () => {
  const shots = [
    { type: 'flat', side: 'fh', userType: 'topspin', userSide: null },
    { type: 'slice', side: 'bh', userType: null, userSide: 'fh' },
    { type: 'serve', side: 'na', userType: null, userSide: null },
  ];
  const s = summarize(shots);
  assert.equal(s.total, 3);
  assert.equal(s.topspin, 1);
  assert.equal(s.flat, 0);
  assert.equal(s.slice, 1);
  assert.equal(s.serve, 1);
  assert.equal(s.fh, 2);
  assert.equal(s.bh, 0);
  assert.equal(s.corrected, 2);
});

test('shotsToCsv มีหัวตารางและจำนวนบรรทัดครบ', () => {
  const { shots } = analyze(makeClip([{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }]));
  const csv = shotsToCsv(shots);
  const lines = csv.split('\n');
  assert.equal(lines.length, shots.length + 1);
  assert.ok(lines[0].startsWith('no,time_sec,type_model,type_label'));
  assert.equal(lines[1].split(',').length, lines[0].split(',').length);
});

test('คลิป 30fps ก็ยังจับช็อตได้ครบ', () => {
  const plan = [{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }, { t: 4.2, kind: 'flat' }];
  const { shots, series } = analyze(makeClip(plan, { fps: 30 }));
  assert.ok(Math.abs(series.fps - 30) < 1);
  assert.equal(shots.length, 3);
});

test('ข้อมือสูงเหนือไหล่แต่ศอกงอ (วอลเลย์สูงติดตัว) ต้องไม่ถูกอ่านเป็นเสิร์ฟ', () => {
  const { shots } = analyze(makeClip([{ t: 1.0, kind: 'highvolley' }]));
  assert.equal(shots.length, 1);
  assert.ok(shots[0].features.vertTop > 0.55, 'ข้อมือต้องขึ้นสูงจริงตามที่ตั้งใจจำลอง');
  assert.ok(shots[0].features.elbowMax < DEFAULT_TUNING.serveElbow, `ศอกต้องยังงออยู่ ได้ ${shots[0].features.elbowMax}`);
  assert.notEqual(shots[0].type, 'serve');
});

test('เสิร์ฟต้องเหยียดศอกตรงจริง ๆ ตามรูปทรงที่จำลอง', () => {
  const { shots } = analyze(makeClip([{ t: 1.0, kind: 'serve' }]));
  assert.equal(shots.length, 1);
  assert.equal(shots[0].type, 'serve');
  assert.ok(shots[0].features.elbowMax > DEFAULT_TUNING.serveElbow, `ศอกควรเหยียด ได้ ${shots[0].features.elbowMax}`);
});

test('รับ image landmark แบบ Float32Array อัดแน่นได้เหมือนอาเรย์อ็อบเจกต์', () => {
  const plan = [{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }];
  const objFrames = makeClip(plan);
  const packedFrames = objFrames.map((f) => {
    if (!f.image) return { t: f.t, world: f.world, image: null };
    const a = new Float32Array(33 * 3);
    f.image.forEach((p, k) => { a[k * 3] = p.x; a[k * 3 + 1] = p.y; a[k * 3 + 2] = p.visibility ?? 1; });
    return { t: f.t, world: f.world, image: a };
  });
  const a = analyze(objFrames);
  const b = analyze(packedFrames);
  assert.deepEqual(b.shots.map((s) => s.type), a.shots.map((s) => s.type));
  assert.deepEqual(b.shots.map((s) => s.side), a.shots.map((s) => s.side));
});

test('world landmark แบบเบาบาง (ใส่มาเฉพาะจุดที่ใช้) ยังวิเคราะห์ได้', () => {
  const need = [0, 11, 12, 13, 14, 15, 16, 23, 24];
  const full = makeClip([{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'slice' }]);
  const sparse = full.map((f) => {
    const w = new Array(33);
    for (const k of need) w[k] = f.world[k];
    return { t: f.t, world: w, image: f.image };
  });
  assert.deepEqual(
    analyze(sparse).shots.map((s) => `${s.type}/${s.side}`),
    analyze(full).shots.map((s) => `${s.type}/${s.side}`),
  );
});
