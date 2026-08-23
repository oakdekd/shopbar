/**
 * เทส end-to-end ของหน้า tennis.html ด้วย Chromium จริง
 *
 * ตัว MediaPipe ถูกแทนด้วย test/mediapipe-stub.js ที่ปล่อย pose สังเคราะห์ตามเวลาในคลิป
 * จึงทดสอบได้ทั้งการดึงเฟรม การคำนวณ และการโต้ตอบบนหน้าเว็บ โดยไม่ต้องต่อ CDN
 * และไม่ต้องมีคลิปเทนนิสจริง
 *
 * วิธีรัน:  node test/e2e.mjs
 * ต้องมี playwright กับ chromium อยู่ในเครื่อง ปรับ path ได้ด้วยตัวแปรแวดล้อม
 *   PLAYWRIGHT_MODULE, CHROMIUM_BIN, FFMPEG_BIN
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8899);
const FFMPEG = process.env.FFMPEG_BIN || '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';
const CHROMIUM = process.env.CHROMIUM_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  || '/opt/node22/lib/node_modules/playwright/index.mjs').catch(() => import('playwright'));

/* ---------- ตัวรันเทสจิ๋ว ---------- */
const results = [];
const ok = (name) => results.push([true, name]);
const check = (name, fn) => {
  try { fn(); ok(name); } catch (e) { results.push([false, `${name} → ${e.message}`]); }
};
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what || ''} ได้ ${JSON.stringify(a)} คาด ${JSON.stringify(b)}`); };

/* ---------- สร้างคลิปทดสอบ (วิดีโอเปล่า ๆ เนื้อหาไม่มีผลเพราะ pose มาจาก stub) ---------- */
async function makeClip(out) {
  if (fs.existsSync(out)) return out;
  const W = 240, H = 135, FPS = 60, DUR = 8;
  const b = await chromium.launch({ executablePath: CHROMIUM });
  const pg = await b.newPage();
  const jpegs = await pg.evaluate(({ W, H, FPS, DUR }) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const out = [];
    for (let f = 0; f < FPS * DUR; f++) {
      ctx.fillStyle = '#1e2838'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#dcf078'; ctx.fillRect((f * 3) % W, 0, 6, H);
      ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'; ctx.fillText(String(f), 8, 24);
      out.push(c.toDataURL('image/jpeg', 0.7).split(',')[1]);
    }
    return out;
  }, { W, H, FPS, DUR });
  await b.close();

  // ffmpeg ที่มากับ playwright ไม่มี protocol pipe: จึงต้องพัก MJPEG ลงไฟล์ก่อน
  const tmp = `${out}.mjpeg`;
  fs.writeFileSync(tmp, Buffer.concat(jpegs.map((s) => Buffer.from(s, 'base64'))));
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg',
    '-r', String(FPS), '-i', `file:${tmp}`, '-c:v', 'libvpx', '-b:v', '400k',
    '-deadline', 'realtime', '-cpu-used', '8', `file:${out}`], { stdio: 'inherit' });
  await new Promise((r) => ff.on('close', r));
  fs.unlinkSync(tmp);
  return out;
}

/* ---------- เสิร์ฟไฟล์ในโปรเจกต์ ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-e2e-'));
const clip = await makeClip(path.join(work, 'clip.webm'));

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const stub = fs.readFileSync(path.join(HERE, 'mediapipe-stub.js'), 'utf8');
await page.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: stub }));
await page.route('https://storage.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'stub-model' }));

const num = async (id) => Number(await page.textContent(`#${id}`));
const col = (n) => page.$$eval(`table.shots tbody tr td:nth-child(${n})`, (c) => c.map((x) => x.textContent.trim()));

await page.goto(`http://localhost:${PORT}/tennis.html`);
await page.setInputFiles('#file-input', clip);
await page.waitForFunction(() => document.getElementById('video').readyState >= 1, null, { timeout: 15000 });
eq(await page.isEnabled('#analyze-btn'), true, 'ปุ่มวิเคราะห์');
ok('เลือกไฟล์แล้วปุ่มวิเคราะห์เปิดใช้งาน');

await page.click('#analyze-btn');
await page.waitForSelector('#summary-card:not([hidden])', { timeout: 180000 });
await page.waitForFunction(() => Number(document.getElementById('s-total').textContent) > 0, null, { timeout: 20000 });

check('ไม่มี JS error ระหว่างประมวลผล', () => eq(errors, []));

const total = await num('s-total');
check('นับสวิงได้ 4 ครั้งตามที่ stub ป้อน', () => eq(total, 4, 'จำนวนสวิง'));
eq(await col(3), ['Topspin', 'Flat', 'Slice', 'เสิร์ฟ/สแมช'], 'ชนิดลูก');
ok('ชนิดลูกเรียงตรงตามรูปสวิงที่ป้อน');
eq(await col(5), ['โฟร์แฮนด์', 'โฟร์แฮนด์', 'แบ็คแฮนด์', '—'], 'ฝั่ง');
ok('ฝั่งโฟร์แฮนด์/แบ็คแฮนด์ตรงตามที่ป้อน');
eq([await num('s-fh'), await num('s-bh'), await num('s-serve')], [2, 1, 1], 'สรุป');
ok('การ์ดสรุปนับ FH / BH / เสิร์ฟ ถูกต้อง');

await page.selectOption('table.shots tbody tr:nth-child(2) select[data-field="type"]', 'topspin');
await page.waitForFunction(() => Number(document.getElementById('s-topspin').textContent) === 2, null, { timeout: 5000 });
eq([await num('s-topspin'), await num('s-flat')], [2, 0], 'หลังแก้ label');
ok('แก้ label เองแล้วสรุปอัปเดตทันที');

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv-btn')]);
const csvPath = path.join(work, 'out.csv');
await dl.saveAs(csvPath);
const csv = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
check('CSV มีหัวตารางและครบทุกช็อต', () => eq(csv.length, 5, 'จำนวนบรรทัด CSV'));
check('CSV เก็บทั้งผลของระบบและค่าที่ผู้ใช้แก้', () => {
  const head = csv[0].split(',');
  const row = csv[2].split(',');
  eq(row[head.indexOf('type_model')], 'flat', 'type_model');
  eq(row[head.indexOf('type_label')], 'topspin', 'type_label');
});

await page.click('table.shots tbody tr:nth-child(1) button[data-action="remove"]');
await page.waitForFunction(() => Number(document.getElementById('s-total').textContent) === 3, null, { timeout: 5000 });
ok('ลบช็อตที่ระบบจับผิดออกได้');

await page.evaluate(() => { document.getElementById('video').currentTime = 7.0; });
await page.waitForTimeout(400);
await page.click('#add-shot-btn');
await page.waitForFunction(() => Number(document.getElementById('s-total').textContent) === 4, null, { timeout: 5000 });
ok('เพิ่มช็อตที่ระบบพลาดเองได้');

await page.evaluate(() => {
  const s = document.getElementById('opt-sensitivity');
  s.value = '0.95';
  s.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
check('เลื่อนความไวแล้วคำนวณใหม่ได้โดยไม่พัง', () => eq(errors, []));

const chart = await page.evaluate(() => {
  const c = document.getElementById('timeline');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  return { w: c.width, colors: seen.size };
});
check('กราฟไทม์ไลน์ถูกวาดจริง', () => { if (!(chart.w > 0 && chart.colors > 3)) throw new Error(`สีที่พบ ${chart.colors}`); });

const ink = await page.evaluate(() => {
  const c = document.getElementById('overlay');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n;
});
check('วาดโครงร่างทับวิดีโอแล้ว', () => { if (ink <= 200) throw new Error(`พิกเซลที่วาด ${ink}`); });

await page.selectOption('#opt-handed', 'left');
await page.waitForTimeout(600);
check('สลับมือถนัดแล้วคำนวณใหม่ได้โดยไม่พัง', () => eq(errors, []));

await browser.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });

const failed = results.filter(([p]) => !p).length;
for (const [pass, name] of results) console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
console.log(`\n${results.length - failed}/${results.length} ผ่าน`);
process.exit(failed ? 1 : 0);
