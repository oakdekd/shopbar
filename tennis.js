/**
 * tennis.js — ส่วนต่อประสานของเครื่องมือวิเคราะห์คลิปเทนนิส
 * หน้าที่: จัดการไฟล์ ดึง pose ทีละเฟรมด้วย MediaPipe แล้วส่งให้ tennis-analysis.js คำนวณ
 * ตัวคำนวณทั้งหมดอยู่ในโมดูลแยกและมีเทสของตัวเอง ไฟล์นี้จึงเน้นเรื่อง DOM กับวิดีโอ
 */
import {
  analyze, classifyShot, summarize, shotsToCsv, shotThreshold, indexAt,
  DEFAULT_TUNING, SHOT_LABELS, SIDE_LABELS,
} from './tennis-analysis.js';

const MP_VERSION = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const modelUrl = (size) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${size}/float16/1/pose_landmarker_${size}.task`;

/** landmark ที่ส่วนคำนวณต้องใช้ — เก็บแค่นี้พอ ประหยัดแรมกับคลิปยาว */
const WORLD_KEEP = [0, 11, 12, 13, 14, 15, 16, 23, 24];

/** เส้นเชื่อมโครงร่าง BlazePose สำหรับวาดทับวิดีโอ */
const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [15, 17], [15, 19], [15, 21], [17, 19],
  [16, 18], [16, 20], [16, 22], [18, 20],
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
];

const TYPE_COLOR = { topspin: '#7c3aed', flat: '#0891b2', slice: '#ea580c', serve: '#65a30d' };
const MAX_FRAMES = 20000;

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('file-input'),
  dropTitle: $('dropzone-title'), dropSub: $('dropzone-sub'),
  handed: $('opt-handed'), model: $('opt-model'), fps: $('opt-fps'),
  sensitivity: $('opt-sensitivity'), sensitivityOut: $('out-sensitivity'),
  analyzeBtn: $('analyze-btn'), cancelBtn: $('cancel-btn'), clipInfo: $('clip-info'),
  progress: $('progress'), progressFill: $('progress-fill'), progressText: $('progress-text'),
  errorBox: $('error-box'),
  videoCard: $('video-card'), video: $('video'), overlay: $('overlay'),
  prevShot: $('prev-shot-btn'), nextShot: $('next-shot-btn'),
  skeleton: $('opt-skeleton'), timeReadout: $('time-readout'),
  summaryCard: $('summary-card'), qualityNote: $('quality-note'),
  timelineCard: $('timeline-card'), timeline: $('timeline'),
  shotsCard: $('shots-card'), shotsBody: $('shots-body'), shotsEmpty: $('shots-empty'),
  addShot: $('add-shot-btn'), exportCsv: $('export-csv-btn'), exportJson: $('export-json-btn'),
  tuningCard: $('tuning-card'), resetTuning: $('reset-tuning-btn'),
};

/** ตัวเลื่อนในแผงค่าขั้นสูง: id ท้าย → จำนวนทศนิยมที่แสดง */
const TUNERS = {
  minGapSec: 2, maxPeakWidth: 2, sliceAngle: 0, topspinAngle: 0,
  topspinFollow: 2, sideThr: 2, serveVert: 2, serveElbow: 0,
};

const state = {
  file: null,
  objectUrl: null,
  frames: [],
  series: null,
  shots: [],
  clipFps: null,
  tuning: { ...DEFAULT_TUNING },
  labels: new Map(),      // key เวลา → { type, side } ที่ผู้ใช้แก้เอง
  removed: new Set(),     // key เวลาของช็อตที่ผู้ใช้ลบทิ้ง
  manualTimes: [],        // เวลาของช็อตที่ผู้ใช้เพิ่มเอง
  activeShot: -1,
  busy: false,
  cancelled: false,
  landmarker: null,
  landmarkerSize: null,
};

const timeKey = (t) => (Math.round(t * 10) / 10).toFixed(1);
const fmtTime = (t) => `${t.toFixed(2)} วิ`;
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

function showError(msg) {
  el.errorBox.textContent = msg;
  el.errorBox.hidden = !msg;
}

function setProgress(ratio, text) {
  el.progress.hidden = false;
  el.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  el.progressText.textContent = text;
}

/* ================= เลือกไฟล์ ================= */

function acceptFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    showError('ไฟล์นี้ไม่ใช่วิดีโอ');
    return;
  }
  showError('');
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = file;
  state.objectUrl = URL.createObjectURL(file);
  state.frames = [];
  state.series = null;
  state.shots = [];
  state.labels.clear();
  state.removed.clear();
  state.manualTimes = [];
  state.clipFps = null;
  state.activeShot = -1;

  el.dropTitle.textContent = file.name;
  el.dropSub.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB — แตะเพื่อเปลี่ยนไฟล์`;
  el.video.src = state.objectUrl;
  el.videoCard.hidden = false;
  el.summaryCard.hidden = true;
  el.timelineCard.hidden = true;
  el.shotsCard.hidden = true;
  el.tuningCard.hidden = true;
  el.analyzeBtn.disabled = false;
  el.clipInfo.textContent = '';
}

el.fileInput.addEventListener('change', () => acceptFile(el.fileInput.files[0]));
['dragenter', 'dragover'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove('is-over'); }));
el.dropzone.addEventListener('drop', (e) => acceptFile(e.dataTransfer?.files?.[0]));

el.video.addEventListener('loadedmetadata', () => {
  const d = Number.isFinite(el.video.duration) ? el.video.duration : null;
  el.clipInfo.textContent = d
    ? `${el.video.videoWidth}×${el.video.videoHeight} · ${d.toFixed(1)} วินาที`
    : `${el.video.videoWidth}×${el.video.videoHeight}`;
  resizeOverlay();
});

/* ================= ประมาณ fps ของคลิป ================= */

/** เล่นคลิปสั้น ๆ แล้วนับ mediaTime จริงเพื่อหา fps — คืน null ถ้าเบราว์เซอร์ไม่รองรับ */
async function estimateVideoFps(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const wasMuted = video.muted;
  return new Promise((resolve) => {
    const times = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      video.muted = wasMuted;
      const d = [];
      for (let i = 1; i < times.length; i++) {
        const x = times[i] - times[i - 1];
        if (x > 1e-4) d.push(x);
      }
      if (d.length < 4) return resolve(null);
      d.sort((a, b) => a - b);
      const med = d[Math.floor(d.length / 2)];
      resolve(med > 1e-4 ? 1 / med : null);
    };
    const step = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 25 || done) return finish();
      video.requestVideoFrameCallback(step);
    };
    video.muted = true;
    video.currentTime = 0;
    video.play().then(() => {
      video.requestVideoFrameCallback(step);
      setTimeout(finish, 2500);
    }).catch(() => { video.muted = wasMuted; resolve(null); });
  });
}

/* ================= MediaPipe ================= */

async function getLandmarker(size) {
  if (state.landmarker && state.landmarkerSize === size) return state.landmarker;
  if (state.landmarker) { state.landmarker.close?.(); state.landmarker = null; }

  const { FilesetResolver, PoseLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = {
    baseOptions: { modelAssetPath: modelUrl(size), delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
  };
  let landmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts);
  } catch {
    // การ์ดจอบางรุ่นสร้าง GPU delegate ไม่ได้ ถอยไปใช้ CPU แทน
    opts.baseOptions.delegate = 'CPU';
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts);
  }
  state.landmarker = landmarker;
  state.landmarkerSize = size;
  return landmarker;
}

/** เลื่อนวิดีโอไปยังเวลาที่ต้องการแล้วรอจนภาพพร้อมจริง */
function seekTo(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/** แปลงผลจาก MediaPipe เป็นรูปแบบเฟรมที่ tennis-analysis.js รับ */
function packFrame(t, result) {
  const has = result && result.worldLandmarks && result.worldLandmarks.length > 0;
  if (!has) return { t, world: null, image: null };

  const w = result.worldLandmarks[0];
  const world = new Array(33);
  for (const k of WORLD_KEEP) {
    const p = w[k];
    if (p) world[k] = { x: p.x, y: p.y, z: p.z };
  }

  const img = result.landmarks?.[0];
  let image = null;
  if (img) {
    image = new Float32Array(33 * 3);
    for (let k = 0; k < 33 && k < img.length; k++) {
      image[k * 3] = img[k].x;
      image[k * 3 + 1] = img[k].y;
      image[k * 3 + 2] = typeof img[k].visibility === 'number' ? img[k].visibility : 1;
    }
  }
  return { t, world, image };
}

/** ไล่ดึง pose ทีละเฟรมด้วยการ seek — ช้ากว่าการเล่นจริงแต่ไม่มีเฟรมหล่นหาย */
async function extractPoses(video, sampleFps, size) {
  const landmarker = await getLandmarker(size);
  const duration = video.duration;
  const step = 1 / sampleFps;
  const frames = [];
  let lastTs = -1;
  let lastT = -1;
  const started = performance.now();
  video.pause();

  for (let i = 0; ; i++) {
    const t = i * step;           // คูณแทนการบวกสะสม กันความคลาดเคลื่อนของ float
    if (t >= duration - 1e-3) break;
    if (state.cancelled) break;
    await seekTo(video, t);
    const actual = video.currentTime;
    // ถ้าสุ่มถี่กว่า fps จริงของคลิป การ seek จะได้เฟรมเดิมซ้ำ — ข้ามไปเลย
    if (actual - lastT < 1e-4) continue;
    lastT = actual;

    const ts = Math.max(lastTs + 1, Math.round(actual * 1000));
    lastTs = ts;
    let result = null;
    try {
      result = landmarker.detectForVideo(video, ts);
    } catch {
      result = null;
    }
    frames.push(packFrame(actual, result));

    if (frames.length % 8 === 0) {
      const ratio = t / duration;
      const elapsed = (performance.now() - started) / 1000;
      const left = ratio > 0.02 ? Math.max(0, elapsed / ratio - elapsed) : null;
      setProgress(
        ratio,
        `กำลังอ่านท่าทาง ${Math.round(ratio * 100)}% (${frames.length} เฟรม)` +
        (left !== null ? ` — เหลืออีกราว ${Math.ceil(left)} วินาที` : ''),
      );
      await raf();
    }
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/* ================= ประมวลผล ================= */

async function runAnalysis() {
  if (state.busy || !state.file) return;
  const video = el.video;
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    showError('อ่านความยาวคลิปไม่ได้ ลองแปลงไฟล์เป็น mp4 (H.264) ก่อน');
    return;
  }

  state.busy = true;
  state.cancelled = false;
  showError('');
  el.analyzeBtn.disabled = true;
  el.cancelBtn.hidden = false;

  try {
    setProgress(0, 'กำลังตรวจ fps ของคลิป…');
    if (state.clipFps === null) state.clipFps = await estimateVideoFps(video);

    const choice = el.fps.value;
    let sampleFps = choice === 'auto' ? (state.clipFps ?? 30) : Number(choice);
    sampleFps = Math.min(Math.max(Math.round(sampleFps), 5), 240);

    const expected = Math.ceil(video.duration * sampleFps);
    if (expected > MAX_FRAMES) {
      showError(
        `คลิปนี้จะได้ราว ${expected.toLocaleString()} เฟรม ซึ่งเกินที่ไหวในเบราว์เซอร์ ` +
        `(จำกัด ${MAX_FRAMES.toLocaleString()}) — ตัดคลิปให้สั้นลง หรือลดอัตราสุ่มเฟรม`,
      );
      return;
    }

    setProgress(0, `กำลังโหลดโมเดล (${el.model.value})…`);
    state.frames = await extractPoses(video, sampleFps, el.model.value);

    if (state.cancelled) {
      setProgress(0, 'ยกเลิกแล้ว');
      return;
    }
    if (!state.frames.length) {
      showError('อ่านเฟรมจากคลิปไม่ได้เลย');
      return;
    }

    state.labels.clear();
    state.removed.clear();
    state.manualTimes = [];
    recompute();

    el.summaryCard.hidden = false;
    el.timelineCard.hidden = false;
    el.shotsCard.hidden = false;
    el.tuningCard.hidden = false;
    setProgress(1, `เสร็จแล้ว — อ่าน ${state.frames.length.toLocaleString()} เฟรม ที่ ${sampleFps} fps`);
    await seekTo(video, state.shots.length ? state.shots[0].time : 0);
    drawOverlay();
  } catch (err) {
    console.error(err);
    const offline = /import|fetch|network|Failed to fetch|dynamically imported/i.test(String(err?.message || err));
    showError(
      offline
        ? 'โหลดโมเดล MediaPipe ไม่สำเร็จ — ต้องต่ออินเทอร์เน็ตในการใช้ครั้งแรก (โมเดลจะถูกแคชไว้หลังจากนั้น)'
        : `เกิดข้อผิดพลาด: ${err?.message || err}`,
    );
  } finally {
    state.busy = false;
    el.analyzeBtn.disabled = false;
    el.cancelBtn.hidden = true;
  }
}

/** คำนวณช็อตใหม่จากเฟรมที่เก็บไว้ — เร็วพอจะเรียกทุกครั้งที่ผู้ใช้ขยับตัวเลื่อน */
function recompute() {
  if (!state.frames.length) return;
  const { series, shots } = analyze(state.frames, state.tuning);
  state.series = series;

  const list = shots.filter((s) => !state.removed.has(timeKey(s.time)));
  for (const t of state.manualTimes) {
    const idx = indexAt(series, t);
    if (idx < 0) continue;
    list.push({
      frameIndex: idx,
      time: series.t[idx],
      manual: true,
      userType: null,
      userSide: null,
      ...classifyShot(series, idx, state.tuning),
    });
  }
  list.sort((a, b) => a.time - b.time);
  list.forEach((s, i) => {
    s.no = i + 1;
    const saved = state.labels.get(timeKey(s.time));
    if (saved) {
      s.userType = saved.type ?? null;
      s.userSide = saved.side ?? null;
    }
  });
  state.shots = list;

  renderSummary();
  renderTable();
  drawTimeline();
}

/* ================= แสดงผล ================= */

function renderSummary() {
  const s = summarize(state.shots);
  $('s-total').textContent = s.total;
  $('s-fh').textContent = s.fh;
  $('s-bh').textContent = s.bh;
  $('s-topspin').textContent = s.topspin;
  $('s-flat').textContent = s.flat;
  $('s-slice').textContent = s.slice;
  $('s-serve').textContent = s.serve;

  const series = state.series;
  const notes = [];
  if (series) {
    const coverage = series.detected / Math.max(1, series.n);
    if (coverage < 0.7) {
      notes.push(`ตรวจเจอตัวผู้เล่นเพียง ${Math.round(coverage * 100)}% ของเฟรม — ผลอาจคลาดเคลื่อน ลองถ่ายให้เห็นตัวเต็มและแสงพอ`);
    }
    if (series.fps < 45) {
      notes.push(`คลิปนี้ประมาณ ${series.fps.toFixed(0)} fps — ที่ต่ำกว่า 60 fps จังหวะปะทะมักไม่มีเฟรมจับได้ การแยก Flat/Topspin จะแม่นน้อยลง`);
    }
  }
  if (s.flat + s.topspin > 0) {
    notes.push('Flat กับ Topspin เป็นการเดาจากท่าทางเท่านั้น — ตรวจแล้วแก้ในตารางได้ ค่าที่แก้จะติดไปกับไฟล์ CSV');
  }
  el.qualityNote.innerHTML = notes.map((n) => `• ${n}`).join('<br>');
  el.qualityNote.hidden = notes.length === 0;
}

function confBar(v, low) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  return `<span class="conf ${low ? 'is-low' : ''}" title="${pct}%"><i style="width:${pct}%"></i></span>`;
}

function renderTable() {
  const rows = state.shots.map((s) => {
    const type = s.userType || s.type;
    const side = s.userSide || s.side;
    const typeOpts = ['topspin', 'flat', 'slice', 'serve']
      .map((k) => `<option value="${k}"${s.userType === k ? ' selected' : ''}>${SHOT_LABELS[k]}</option>`).join('');
    const sideOpts = ['fh', 'bh', 'na']
      .map((k) => `<option value="${k}"${s.userSide === k ? ' selected' : ''}>${SIDE_LABELS[k]}</option>`).join('');
    return `<tr data-no="${s.no}"${s.no - 1 === state.activeShot ? ' class="is-active"' : ''}>
      <td class="num">${s.no}${s.manual ? ' <span title="เพิ่มเอง">✎</span>' : ''}</td>
      <td class="num">${fmtTime(s.time)}</td>
      <td><span class="pill pill-${s.type}">${SHOT_LABELS[s.type]}</span></td>
      <td><select data-field="type" class="${s.userType ? 'is-edited' : ''}"><option value="">— ตามระบบ —</option>${typeOpts}</select></td>
      <td>${SIDE_LABELS[s.side]}</td>
      <td><select data-field="side" class="${s.userSide ? 'is-edited' : ''}"><option value="">— ตามระบบ —</option>${sideOpts}</select></td>
      <td class="num">${s.features.pathAngle.toFixed(0)}°</td>
      <td class="num">${s.features.peakSpeed.toFixed(1)}</td>
      <td>${confBar(s.typeConf, type === 'flat' || type === 'topspin')}</td>
      <td><button type="button" class="btn btn-danger-text" data-action="remove">ลบ</button></td>
    </tr>`;
  });
  el.shotsBody.innerHTML = rows.join('');
  el.shotsEmpty.hidden = rows.length > 0;
}

/** ปรับความละเอียด canvas ให้ตรงกับกล่องวิดีโอ คืน true ถ้าขนาดใช้ได้ */
function resizeOverlay() {
  const c = el.overlay;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(el.video.clientWidth * dpr);
  const h = Math.round(el.video.clientHeight * dpr);
  if (!w || !h) return false;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return true;
}

/** วาดโครงร่างทับวิดีโอ โดยชดเชย letterbox ของ object-fit: contain */
function drawOverlay() {
  const c = el.overlay;
  const ctx = c.getContext('2d');
  if (!ctx || !resizeOverlay()) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!el.skeleton.checked || !state.series || !state.frames.length) return;

  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  const bw = el.video.clientWidth, bh = el.video.clientHeight;
  if (!vw || !vh || !bw || !bh) return;

  const idx = indexAt(state.series, el.video.currentTime);
  const img = idx >= 0 ? state.frames[idx]?.image : null;
  if (!img) return;

  const dpr = window.devicePixelRatio || 1;
  ctx.scale(dpr, dpr);
  const scale = Math.min(bw / vw, bh / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (bw - dw) / 2, oy = (bh - dh) / 2;
  const px = (k) => ox + img[k * 3] * dw;
  const py = (k) => oy + img[k * 3 + 1] * dh;
  const vis = (k) => img[k * 3 + 2];

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    if (vis(a) < 0.4 || vis(b) < 0.4) continue;
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(b), py(b));
  }
  ctx.stroke();

  ctx.fillStyle = '#fff';
  for (let k = 0; k < 33; k++) {
    if (vis(k) < 0.4) continue;
    ctx.beginPath();
    ctx.arc(px(k), py(k), 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // เน้นข้อมือข้างที่ถนัด เพราะเป็นจุดที่ใช้ตัดสินทั้งหมด
  const wrist = state.tuning.handed === 'left' ? 15 : 16;
  if (vis(wrist) >= 0.4) {
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.arc(px(wrist), py(wrist), 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTimeline() {
  const c = el.timeline;
  const series = state.series;
  if (!series) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 800;
  const h = 150;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 8, r: 8, t: 10, b: 20 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const duration = series.t[series.n - 1] || 1;
  let vmax = 0;
  for (let i = 0; i < series.n; i++) if (series.valid[i] && series.speed[i] > vmax) vmax = series.speed[i];
  vmax = vmax || 1;
  const X = (t) => pad.l + (t / duration) * plotW;
  const Y = (v) => pad.t + plotH - (v / vmax) * plotH;

  ctx.fillStyle = '#f9fafb';
  ctx.fillRect(pad.l, pad.t, plotW, plotH);

  // เส้นเกณฑ์ที่ใช้ตัดสินว่าเป็นสวิง ช่วยให้เห็นว่าควรเลื่อนความไวไปทางไหน
  const thr = shotThreshold(series, state.tuning);
  if (Number.isFinite(thr) && thr < vmax) {
    ctx.strokeStyle = '#d1d5db';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(thr));
    ctx.lineTo(pad.l + plotW, Y(thr));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('เกณฑ์', pad.l + 3, Y(thr) - 4);
  }

  // ย่อเป็นค่าสูงสุดต่อคอลัมน์พิกเซล — คลิปยาวมีได้เป็นหมื่นจุด วาดตรง ๆ จะหน่วงตอนเล่นวิดีโอ
  const cols = Math.max(1, Math.floor(plotW));
  const peak = new Float64Array(cols).fill(NaN);
  for (let i = 0; i < series.n; i++) {
    if (!series.valid[i]) continue;
    const col = Math.min(cols - 1, Math.floor((series.t[i] / duration) * cols));
    if (Number.isNaN(peak[col]) || series.speed[i] > peak[col]) peak[col] = series.speed[i];
  }
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let pen = false;
  for (let col = 0; col < cols; col++) {
    if (Number.isNaN(peak[col])) { pen = false; continue; }
    const x = pad.l + col, y = Y(peak[col]);
    if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
  }
  ctx.stroke();

  for (const s of state.shots) {
    const type = s.userType || s.type;
    const x = X(s.time);
    ctx.strokeStyle = TYPE_COLOR[type] || '#111827';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.fillStyle = TYPE_COLOR[type] || '#111827';
    ctx.beginPath();
    ctx.arc(x, pad.t + 4, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  const cur = el.video.currentTime;
  if (Number.isFinite(cur)) {
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(cur), pad.t);
    ctx.lineTo(X(cur), pad.t + plotH);
    ctx.stroke();
  }

  ctx.fillStyle = '#6b7280';
  ctx.font = '11px system-ui, sans-serif';
  for (let k = 0; k <= 4; k++) {
    const t = (duration * k) / 4;
    ctx.fillText(`${t.toFixed(1)}s`, X(t) - (k === 4 ? 24 : 0), h - 6);
  }
}

/* ================= การโต้ตอบ ================= */

function gotoShot(i) {
  if (!state.shots.length) return;
  state.activeShot = Math.max(0, Math.min(state.shots.length - 1, i));
  el.video.pause();
  el.video.currentTime = state.shots[state.activeShot].time;
  renderTable();
}

el.analyzeBtn.addEventListener('click', runAnalysis);
el.cancelBtn.addEventListener('click', () => { state.cancelled = true; });

el.sensitivity.addEventListener('input', () => {
  state.tuning.sensitivity = Number(el.sensitivity.value);
  el.sensitivityOut.textContent = state.tuning.sensitivity.toFixed(2);
  if (state.frames.length) recompute();
});

el.handed.addEventListener('change', () => {
  state.tuning.handed = el.handed.value;
  if (state.frames.length) { recompute(); drawOverlay(); }
});

el.skeleton.addEventListener('change', drawOverlay);
el.prevShot.addEventListener('click', () => gotoShot(state.activeShot - 1));
el.nextShot.addEventListener('click', () => gotoShot(state.activeShot + 1));

el.shotsBody.addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  const no = Number(row.dataset.no);
  const shot = state.shots.find((s) => s.no === no);
  if (!shot) return;

  if (e.target.dataset.action === 'remove') {
    e.stopPropagation();
    const key = timeKey(shot.time);
    if (shot.manual) {
      state.manualTimes = state.manualTimes.filter((t) => timeKey(t) !== key);
    } else {
      state.removed.add(key);
    }
    state.labels.delete(key);
    recompute();
    return;
  }
  if (e.target.tagName === 'SELECT') return;
  gotoShot(no - 1);
});

el.shotsBody.addEventListener('change', (e) => {
  const sel = e.target;
  if (sel.tagName !== 'SELECT') return;
  const no = Number(sel.closest('tr').dataset.no);
  const shot = state.shots.find((s) => s.no === no);
  if (!shot) return;
  const key = timeKey(shot.time);
  const entry = state.labels.get(key) || { type: null, side: null };
  entry[sel.dataset.field] = sel.value || null;
  if (!entry.type && !entry.side) state.labels.delete(key);
  else state.labels.set(key, entry);
  recompute();
});

el.addShot.addEventListener('click', () => {
  if (!state.series) return;
  const t = el.video.currentTime;
  if (state.manualTimes.some((x) => Math.abs(x - t) < 0.05)) return;
  state.manualTimes.push(t);
  // ถ้าเคยลบช็อตอัตโนมัติที่เวลานี้ไว้ การเพิ่มใหม่ถือว่าเปลี่ยนใจ
  state.removed.delete(timeKey(t));
  recompute();
});

el.timeline.addEventListener('click', (e) => {
  if (!state.series) return;
  const rect = el.timeline.getBoundingClientRect();
  const duration = state.series.t[state.series.n - 1] || 1;
  const ratio = (e.clientX - rect.left - 8) / Math.max(1, rect.width - 16);
  el.video.pause();
  el.video.currentTime = Math.max(0, Math.min(duration, ratio * duration));
});

el.video.addEventListener('timeupdate', () => {
  el.timeReadout.textContent = fmtTime(el.video.currentTime);
});
['seeked', 'loadeddata'].forEach((ev) => el.video.addEventListener(ev, () => { drawOverlay(); drawTimeline(); }));
let drawLoopRunning = false;
el.video.addEventListener('play', () => {
  if (drawLoopRunning) return;
  drawLoopRunning = true;
  const tick = () => {
    if (el.video.paused || el.video.ended) { drawLoopRunning = false; return; }
    drawOverlay();
    drawTimeline();
    requestAnimationFrame(tick);
  };
  tick();
});
window.addEventListener('resize', () => { resizeOverlay(); drawOverlay(); drawTimeline(); });

/* ---- แผงค่าขั้นสูง ---- */

function syncTuner(name) {
  const input = $(`t-${name}`);
  const out = $(`o-${name}`);
  if (!input || !out) return;
  input.value = String(state.tuning[name]);
  out.textContent = Number(state.tuning[name]).toFixed(TUNERS[name]);
}

for (const name of Object.keys(TUNERS)) {
  const input = $(`t-${name}`);
  if (!input) continue;
  input.addEventListener('input', () => {
    state.tuning[name] = Number(input.value);
    $(`o-${name}`).textContent = Number(input.value).toFixed(TUNERS[name]);
    if (state.frames.length) recompute();
  });
  syncTuner(name);
}

el.resetTuning.addEventListener('click', () => {
  state.tuning = { ...DEFAULT_TUNING, handed: el.handed.value, sensitivity: Number(el.sensitivity.value) };
  Object.keys(TUNERS).forEach(syncTuner);
  if (state.frames.length) recompute();
});

/* ---- ส่งออก ---- */

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = () => (state.file?.name || 'clip').replace(/\.[^.]+$/, '');

el.exportCsv.addEventListener('click', () => {
  if (!state.shots.length) return;
  download(`${baseName()}-shots.csv`, shotsToCsv(state.shots), 'text/csv;charset=utf-8');
});

el.exportJson.addEventListener('click', () => {
  if (!state.shots.length) return;
  const payload = {
    clip: {
      name: state.file?.name ?? null,
      durationSec: el.video.duration ?? null,
      width: el.video.videoWidth,
      height: el.video.videoHeight,
      detectedFps: state.clipFps,
      sampledFrames: state.frames.length,
      analysisFps: state.series?.fps ?? null,
      poseCoverage: state.series ? state.series.detected / Math.max(1, state.series.n) : null,
    },
    tuning: state.tuning,
    summary: summarize(state.shots),
    shots: state.shots.map((s) => ({
      no: s.no,
      time: s.time,
      typeModel: s.type,
      typeLabel: s.userType,
      sideModel: s.side,
      sideLabel: s.userSide,
      typeConf: s.typeConf,
      sideConf: s.sideConf,
      manual: s.manual,
      features: s.features,
    })),
  };
  download(`${baseName()}-shots.json`, JSON.stringify(payload, null, 2), 'application/json');
});

el.sensitivityOut.textContent = Number(el.sensitivity.value).toFixed(2);
