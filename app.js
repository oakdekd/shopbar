(function () {
  const form = document.getElementById('barcode-form');
  const nameInput = document.getElementById('product-name');
  const valueInput = document.getElementById('barcode-value');
  const formatSelect = document.getElementById('format');
  const heightInput = document.getElementById('height');
  const valueHint = document.getElementById('value-hint');
  const errorEl = document.getElementById('error');

  const previewName = document.getElementById('preview-name');
  const previewValue = document.getElementById('preview-value');
  const barcodeSvg = document.getElementById('barcode');

  const saveBtn = document.getElementById('save-btn');
  const downloadPngBtn = document.getElementById('download-png');
  const downloadSvgBtn = document.getElementById('download-svg');
  const printBtn = document.getElementById('print-btn');

  const savedList = document.getElementById('saved-list');
  const savedEmpty = document.getElementById('saved-empty');
  const clearSavedBtn = document.getElementById('clear-saved');

  document.getElementById('year').textContent = new Date().getFullYear();

  const STORAGE_KEY = 'shopbarcode.saved.v1';

  const FORMAT_HINTS = {
    CODE128: 'CODE128 accepts letters, numbers, and symbols.',
    EAN13: 'EAN-13 needs 12 digits (13th is calculated) or 13 digits with valid check.',
    EAN8: 'EAN-8 needs 7 digits (8th is calculated) or 8 digits with valid check.',
    UPC: 'UPC-A needs 11 digits (12th is calculated) or 12 digits with valid check.',
    CODE39: 'CODE39 accepts A-Z, 0-9, and - . $ / + % space.',
    ITF14: 'ITF-14 needs 13 digits (14th is calculated) or 14 digits.'
  };

  let lastGenerated = null;

  function setError(msg) {
    errorEl.textContent = msg || '';
  }

  function generate() {
    setError('');
    const name = nameInput.value.trim();
    const value = valueInput.value.trim();
    const format = formatSelect.value;
    const height = clampInt(heightInput.value, 20, 200, 80);

    if (!name) { setError('Please enter a product name.'); return null; }
    if (!value) { setError('Please enter a barcode value.'); return null; }

    try {
      JsBarcode(barcodeSvg, value, {
        format: format,
        height: height,
        width: 2,
        displayValue: true,
        fontSize: 14,
        margin: 8,
        background: '#ffffff',
        lineColor: '#000000'
      });
    } catch (err) {
      setError(err && err.message ? err.message : 'Could not generate barcode for this value.');
      return null;
    }

    previewName.textContent = name;
    previewValue.textContent = value + '  ·  ' + format;

    lastGenerated = { name, value, format, height, ts: Date.now() };
    return lastGenerated;
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function getSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function setSaved(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    renderSaved();
  }

  function renderSaved() {
    const list = getSaved();
    savedList.innerHTML = '';
    if (list.length === 0) {
      savedEmpty.style.display = '';
      clearSavedBtn.style.display = 'none';
      return;
    }
    savedEmpty.style.display = 'none';
    clearSavedBtn.style.display = '';

    list.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'saved-item';

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = item.name;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      try {
        JsBarcode(svg, item.value, {
          format: item.format,
          height: 50,
          width: 1.6,
          displayValue: true,
          fontSize: 12,
          margin: 4,
          background: '#ffffff',
          lineColor: '#000000'
        });
      } catch (e) { /* ignore broken item */ }

      const valueEl = document.createElement('div');
      valueEl.className = 'value';
      valueEl.textContent = item.value + ' · ' + item.format;

      const row = document.createElement('div');
      row.className = 'row';

      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn small';
      loadBtn.type = 'button';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        nameInput.value = item.name;
        valueInput.value = item.value;
        formatSelect.value = item.format;
        heightInput.value = item.height || 80;
        updateHint();
        generate();
        document.getElementById('generator').scrollIntoView({ behavior: 'smooth' });
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'btn small ghost';
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        const next = getSaved();
        next.splice(idx, 1);
        setSaved(next);
      });

      row.appendChild(loadBtn);
      row.appendChild(delBtn);

      li.appendChild(nameEl);
      li.appendChild(svg);
      li.appendChild(valueEl);
      li.appendChild(row);
      savedList.appendChild(li);
    });
  }

  function downloadSvg() {
    if (!lastGenerated) { setError('Generate a barcode first.'); return; }
    const clone = barcodeSvg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    triggerDownload(URL.createObjectURL(blob), filename(lastGenerated) + '.svg');
  }

  function downloadPng() {
    if (!lastGenerated) { setError('Generate a barcode first.'); return; }
    const svgStr = new XMLSerializer().serializeToString(barcodeSvg);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = function () {
      const scale = 2;
      const w = (barcodeSvg.viewBox.baseVal && barcodeSvg.viewBox.baseVal.width) || barcodeSvg.clientWidth || img.width;
      const h = (barcodeSvg.viewBox.baseVal && barcodeSvg.viewBox.baseVal.height) || barcodeSvg.clientHeight || img.height;
      const labelHeight = 28;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(w * scale);
      canvas.height = Math.ceil((h + labelHeight) * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#111418';
      ctx.font = 'bold ' + (14 * scale) + 'px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(lastGenerated.name, canvas.width / 2, 6 * scale);
      ctx.drawImage(img, 0, labelHeight * scale, canvas.width, h * scale);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) {
        triggerDownload(URL.createObjectURL(blob), filename(lastGenerated) + '.png');
      }, 'image/png');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      setError('Could not render PNG.');
    };
    img.src = url;
  }

  function triggerDownload(href, name) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 4000);
  }

  function filename(item) {
    const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'barcode';
    return slug + '-' + item.value;
  }

  function updateHint() {
    valueHint.textContent = FORMAT_HINTS[formatSelect.value] || '';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    generate();
  });

  saveBtn.addEventListener('click', function () {
    const item = generate();
    if (!item) return;
    const list = getSaved();
    list.unshift(item);
    setSaved(list.slice(0, 100));
  });

  downloadPngBtn.addEventListener('click', downloadPng);
  downloadSvgBtn.addEventListener('click', downloadSvg);
  printBtn.addEventListener('click', function () {
    if (!lastGenerated) { setError('Generate a barcode first.'); return; }
    window.print();
  });

  clearSavedBtn.addEventListener('click', function () {
    if (confirm('Delete all saved barcodes?')) setSaved([]);
  });

  formatSelect.addEventListener('change', updateHint);

  updateHint();
  renderSaved();

  nameInput.value = 'Sample Product';
  valueInput.value = '1234567890128';
  generate();
})();
