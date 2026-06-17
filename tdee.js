(function () {
  'use strict';

  // 7,000 kcal ≈ ลดน้ำหนัก 1 กก. (ตามที่โจทย์กำหนด)
  const KCAL_PER_KG = 7000;

  const form = document.getElementById('tdee-form');
  const resultCard = document.getElementById('result-card');
  const errorText = document.getElementById('error-text');

  const targetField = document.getElementById('target-field');
  const amountField = document.getElementById('amount-field');

  const outBmr = document.getElementById('out-bmr');
  const outTdee = document.getElementById('out-tdee');
  const outBmi = document.getElementById('out-bmi');
  const outBmiCat = document.getElementById('out-bmi-cat');
  const bmiMarker = document.getElementById('bmi-marker');
  const planList = document.getElementById('plan-list');
  const planBox = document.getElementById('plan-box');

  /* ---------- Goal mode toggle ---------- */
  form.addEventListener('change', function (e) {
    if (e.target.name === 'goalMode') {
      const mode = getGoalMode();
      targetField.hidden = mode !== 'target';
      amountField.hidden = mode !== 'amount';
    }
  });

  function getGoalMode() {
    const el = form.querySelector('input[name="goalMode"]:checked');
    return el ? el.value : 'target';
  }

  /* ---------- Submit ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideError();

    const gender = form.querySelector('input[name="gender"]:checked').value;
    const age = num('age');
    const height = num('height');
    const weight = num('weight');
    const activity = parseFloat(document.getElementById('activity').value);
    const deficit = parseFloat(document.getElementById('deficit').value);

    if (!isValid(age, 10, 100)) return showError('กรุณากรอกอายุระหว่าง 10–100 ปี');
    if (!isValid(height, 100, 250)) return showError('กรุณากรอกส่วนสูงระหว่าง 100–250 ซม.');
    if (!isValid(weight, 25, 400)) return showError('กรุณากรอกน้ำหนักระหว่าง 25–400 กก.');

    // BMR — Mifflin–St Jeor
    const base = 10 * weight + 6.25 * height - 5 * age;
    const bmr = gender === 'male' ? base + 5 : base - 161;
    const tdee = bmr * activity;

    // BMI
    const hM = height / 100;
    const bmi = weight / (hM * hM);

    outBmr.textContent = fmt(Math.round(bmr));
    outTdee.textContent = fmt(Math.round(tdee));
    outBmi.textContent = bmi.toFixed(1);

    const cat = bmiCategory(bmi);
    outBmiCat.textContent = cat.label;
    outBmiCat.style.color = cat.color;
    bmiMarker.style.left = bmiMarkerPos(bmi) + '%';

    renderPlan(weight, bmi, tdee, deficit);

    resultCard.hidden = false;
    if (window.matchMedia('(max-width: 760px)').matches) {
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  form.addEventListener('reset', function () {
    hideError();
    resultCard.hidden = true;
  });

  /* ---------- Weight-loss plan ---------- */
  function renderPlan(weight, bmi, tdee, deficit) {
    planList.innerHTML = '';
    removeNotes();

    const mode = getGoalMode();
    let lossKg;

    if (mode === 'target') {
      const target = num('targetWeight');
      if (!isFinite(target) || target <= 0) {
        appendNote('warn', 'กรอกน้ำหนักเป้าหมายเพื่อดูแผนการลดน้ำหนัก');
        return;
      }
      lossKg = weight - target;
      addRow('น้ำหนักเป้าหมาย', target.toFixed(1) + ' กก.');
    } else {
      lossKg = num('lossAmount');
      if (!isFinite(lossKg) || lossKg <= 0) {
        appendNote('warn', 'กรอกจำนวนกิโลกรัมที่ต้องการลดเพื่อดูแผน');
        return;
      }
      addRow('น้ำหนักเป้าหมาย', (weight - lossKg).toFixed(1) + ' กก.');
    }

    if (lossKg <= 0) {
      appendNote('ok', 'น้ำหนักเป้าหมายมากกว่าหรือเท่ากับน้ำหนักปัจจุบัน — คุณไม่จำเป็นต้องลดน้ำหนัก 🎉');
      return;
    }

    const totalKcal = lossKg * KCAL_PER_KG;
    const days = Math.ceil(totalKcal / deficit);
    const weeks = days / 7;
    const targetCalories = Math.round(tdee - deficit);
    const targetDate = addDays(new Date(), days);
    const weeklyRate = (deficit * 7) / KCAL_PER_KG;

    addRow('ต้องลดทั้งหมด', lossKg.toFixed(1) + ' กก.');
    addRow('พลังงานสะสมที่ต้องเผาผลาญ', fmt(Math.round(totalKcal)) + ' kcal');
    addRow('กินได้วันละ (TDEE − ' + fmt(deficit) + ')', fmt(targetCalories) + ' kcal/วัน', true);
    addRow('อัตราการลดโดยประมาณ', weeklyRate.toFixed(2) + ' กก./สัปดาห์');
    addRow('ใช้เวลาประมาณ', fmt(days) + ' วัน (≈ ' + weeks.toFixed(1) + ' สัปดาห์)', true);
    addRow('คาดว่าถึงเป้าหมายวันที่', formatThaiDate(targetDate));

    // คำเตือนความปลอดภัย
    if (targetCalories < 1200) {
      appendNote('warn', '⚠️ พลังงานที่แนะนำต่อวัน (' + fmt(targetCalories) +
        ' kcal) ต่ำกว่า 1,200 kcal ซึ่งอาจไม่ปลอดภัย ควรลดอัตรา Deficit ลง หรือปรึกษาผู้เชี่ยวชาญ');
    } else if (weeklyRate > 1) {
      appendNote('warn', '⚠️ อัตราการลดเร็วเกิน 1 กก./สัปดาห์ อาจเสี่ยงต่อการสูญเสียมวลกล้ามเนื้อ แนะนำให้ค่อยเป็นค่อยไป');
    } else {
      appendNote('ok', '✅ แผนนี้อยู่ในเกณฑ์ปลอดภัย เน้นกินโปรตีนให้พอและออกกำลังกายควบคู่เพื่อรักษามวลกล้ามเนื้อ');
    }
  }

  /* ---------- Helpers ---------- */
  function bmiCategory(bmi) {
    if (bmi < 18.5) return { label: 'น้ำหนักน้อย', color: '#2563eb' };
    if (bmi < 23) return { label: 'ปกติ', color: '#16a34a' };
    if (bmi < 25) return { label: 'ท้วม', color: '#d97706' };
    if (bmi < 30) return { label: 'อ้วนระดับ 1', color: '#ea580c' };
    return { label: 'อ้วนระดับ 2', color: '#dc2626' };
  }

  // วาง marker บนแกน BMI 15–35 (คลิปไว้ในช่วง 0–100%)
  function bmiMarkerPos(bmi) {
    const min = 15, max = 35;
    const pct = ((bmi - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  function addRow(key, val, highlight) {
    const li = document.createElement('li');
    if (highlight) li.className = 'highlight';
    const k = document.createElement('span');
    k.className = 'pl-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'pl-val';
    v.textContent = val;
    li.appendChild(k);
    li.appendChild(v);
    planList.appendChild(li);
  }

  function appendNote(type, text) {
    const p = document.createElement('p');
    p.className = 'plan-note ' + type;
    p.textContent = text;
    planBox.appendChild(p);
  }
  function removeNotes() {
    planBox.querySelectorAll('.plan-note').forEach(function (n) { n.remove(); });
  }

  function num(id) {
    return parseFloat(document.getElementById(id).value);
  }
  function isValid(v, min, max) {
    return isFinite(v) && v >= min && v <= max;
  }
  function fmt(n) {
    return Number(n).toLocaleString('en-US');
  }
  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }
  function formatThaiDate(d) {
    const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  }

  function showError(msg) {
    errorText.textContent = msg;
    errorText.hidden = false;
    resultCard.hidden = true;
  }
  function hideError() {
    errorText.hidden = true;
    errorText.textContent = '';
  }
})();
