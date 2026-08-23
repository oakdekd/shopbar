/* stub ของ @mediapipe/tasks-vision ที่ปล่อย pose สังเคราะห์ตามเวลาในคลิป
   ใช้ในเทส end-to-end เท่านั้น เพื่อทดสอบโค้ดหน้าเว็บโดยไม่ต้องต่อ CDN */
const TORSO = 0.5, UPPER = 0.28, FORE = 0.26;
const lerp = (a, b, u) => ({ lat: a.lat + (b.lat - a.lat) * u, vert: a.vert + (b.vert - a.vert) * u, dep: a.dep + (b.dep - a.dep) * u });
const smoothstep = (u) => u * u * (3 - 2 * u);
const STROKES = {
  topspin: { start: { lat: 0.70, vert: -0.55, dep: 0.10 }, contact: { lat: 0.75, vert: -0.05, dep: 0.60 }, end: { lat: -0.20, vert: 0.45, dep: 0.50 } },
  flat:    { start: { lat: 0.85, vert: -0.15, dep: 0.15 }, contact: { lat: 0.80, vert: 0.00, dep: 0.65 }, end: { lat: 0.30, vert: 0.12, dep: 1.00 } },
  slice:   { start: { lat: -0.35, vert: 0.35, dep: 0.30 }, contact: { lat: -0.45, vert: -0.10, dep: 0.65 }, end: { lat: -0.55, vert: -0.30, dep: 0.90 } },
  serve:   { start: { lat: 0.20, vert: -0.50, dep: 0.10 }, contact: { lat: 0.35, vert: 1.00, dep: 0.35 }, end: { lat: -0.40, vert: -0.40, dep: 0.70 } },
};
const PLAN = [{ t: 1.0, kind: 'topspin' }, { t: 2.6, kind: 'flat' }, { t: 4.2, kind: 'slice' }, { t: 5.8, kind: 'serve' }];
const REST = { lat: 0.35, vert: -0.75, dep: 0.25 }, HALF = 0.5, TOTAL = 8;

function poseAt(t) {
  for (const s of PLAN) {
    const tau = t - s.t;
    if (Math.abs(tau) <= HALF) {
      const st = STROKES[s.kind];
      const g = 0.5 * (1 + Math.tanh(tau / 0.10));
      return g < 0.5 ? lerp(st.start, st.contact, g * 2) : lerp(st.contact, st.end, (g - 0.5) * 2);
    }
  }
  const prev = [...PLAN].reverse().find((s) => t > s.t + HALF);
  const next = PLAN.find((s) => t < s.t - HALF);
  const from = prev ? STROKES[prev.kind].end : REST;
  const to = next ? STROKES[next.kind].start : REST;
  const a = prev ? prev.t + HALF : 0, b = next ? next.t - HALF : TOTAL;
  const u = b > a ? smoothstep(Math.min(1, Math.max(0, (t - a) / (b - a)))) : 1;
  return lerp(from, to, u);
}

function placeElbow(S, W) {
  const d = { x: W.x - S.x, y: W.y - S.y, z: W.z - S.z };
  const L = Math.max(Math.hypot(d.x, d.y, d.z), 1e-6);
  const reach = Math.min(L, UPPER + FORE - 1e-4);
  const dh = { x: d.x / L, y: d.y / L, z: d.z / L };
  const u = (reach * reach + UPPER * UPPER - FORE * FORE) / (2 * reach);
  const v = Math.sqrt(Math.max(0, UPPER * UPPER - u * u));
  const ref = { x: 0, y: 1, z: 0.3 };
  const pr = ref.x * dh.x + ref.y * dh.y + ref.z * dh.z;
  let pp = { x: ref.x - pr * dh.x, y: ref.y - pr * dh.y, z: ref.z - pr * dh.z };
  const pn = Math.hypot(pp.x, pp.y, pp.z) || 1;
  return { x: S.x + dh.x * u + (pp.x / pn) * v, y: S.y + dh.y * u + (pp.y / pn) * v, z: S.z + dh.z * u + (pp.z / pn) * v, visibility: 1 };
}

function worldAt(t) {
  const { lat, vert, dep } = poseAt(t);
  const p = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  p[11] = { x: -0.18, y: -0.50, z: 0, visibility: 1 };
  p[12] = { x: 0.18, y: -0.50, z: 0, visibility: 1 };
  p[23] = { x: -0.12, y: 0, z: 0, visibility: 1 };
  p[24] = { x: 0.12, y: 0, z: 0, visibility: 1 };
  p[0] = { x: 0, y: -0.72, z: 0, visibility: 1 };
  p[16] = { x: lat * TORSO, y: -0.5 - vert * TORSO, z: -dep * TORSO, visibility: 1 };
  p[14] = placeElbow(p[12], p[16]);
  return p;
}

export class FilesetResolver {
  static async forVisionTasks() { return { __stub: true }; }
}

export class PoseLandmarker {
  static POSE_CONNECTIONS = [];
  static async createFromOptions(_fileset, opts) {
    if (opts?.baseOptions?.delegate === 'GPU') throw new Error('stub: ไม่มี GPU delegate');
    return new PoseLandmarker();
  }
  detectForVideo(_video, tsMs) {
    const world = worldAt(tsMs / 1000);
    const landmarks = world.map((p) => ({ x: 0.5 + p.x * 0.5, y: 0.55 + p.y * 0.45, z: p.z, visibility: 1 }));
    return { worldLandmarks: [world], landmarks: [landmarks] };
  }
  close() {}
}
