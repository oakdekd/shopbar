(function () {
  const form = document.getElementById('add-form');
  const nameInput = document.getElementById('product-name');
  const trackingInput = document.getElementById('tracking');
  const itemsBody = document.getElementById('items-body');
  const emptyState = document.getElementById('empty-state');
  const printBtn = document.getElementById('print-btn');
  const clearBtn = document.getElementById('clear-btn');
  const pasteBtn = document.getElementById('paste-btn');

  const STORAGE_KEY = 'shopbarcode.items.v2';

  let items = load();
  render();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    const name = nameInput.value.trim();
    const tracking = trackingInput.value.trim();
    if (!name || !tracking) return;

    items.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: name,
      tracking: tracking,
      packed: false
    });
    save();
    render();

    form.reset();
    nameInput.focus();
  });

  clearBtn.addEventListener('click', function () {
    if (items.length === 0) return;
    if (confirm('ลบรายการทั้งหมด?')) {
      items = [];
      save();
      render();
    }
  });

  printBtn.addEventListener('click', function () {
    if (items.length === 0) {
      alert('ยังไม่มีรายการ เพิ่มสินค้าก่อนพิมพ์');
      return;
    }
    window.print();
  });

  pasteBtn.addEventListener('click', async function () {
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      } else {
        throw new Error('no-clipboard');
      }
    } catch (e) {
      trackingInput.focus();
      alert('เบราว์เซอร์ไม่อนุญาตให้อ่าน clipboard กรุณาคลิกที่ช่อง Tracking แล้วกด Ctrl/Cmd+V');
      return;
    }
    text = (text || '').trim();
    if (!text) {
      trackingInput.focus();
      return;
    }
    trackingInput.value = text;
    flashPasteSuccess();
    if (nameInput.value.trim()) {
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    } else {
      nameInput.focus();
    }
  });

  function flashPasteSuccess() {
    pasteBtn.classList.add('is-success');
    setTimeout(() => pasteBtn.classList.remove('is-success'), 600);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return migrateFromV1();
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }

  function migrateFromV1() {
    try {
      const old = localStorage.getItem('shopbarcode.items.v1');
      if (!old) return [];
      const parsed = JSON.parse(old);
      return parsed.map(it => Object.assign({ packed: false }, it));
    } catch (e) { return []; }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  function render() {
    itemsBody.innerHTML = '';

    if (items.length === 0) {
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';

    items.forEach((item, idx) => {
      const tr = document.createElement('tr');

      const tdNo = document.createElement('td');
      tdNo.textContent = idx + 1;
      tdNo.className = 'cell-no';
      tr.appendChild(tdNo);

      const tdName = document.createElement('td');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'item-name';
      nameDiv.textContent = item.name;
      tdName.appendChild(nameDiv);
      tr.appendChild(tdName);

      const tdStatus = document.createElement('td');
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'status-badge ' + (item.packed ? 'is-packed' : 'is-pending');
      badge.innerHTML = item.packed
        ? '<span class="status-ico">✓</span><span>แพ๊คแล้ว</span>'
        : '<span class="status-ico">⏳</span><span>ยังไม่แพ๊ค</span>';
      badge.title = item.packed ? 'คลิกเพื่อเปลี่ยนเป็นยังไม่แพ๊ค' : 'คลิกเมื่อแพ๊คเสร็จแล้ว';
      badge.addEventListener('click', function () {
        items[idx].packed = !items[idx].packed;
        save();
        render();
      });
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      const tdBarcode = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'barcode-cell';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      try {
        JsBarcode(svg, item.tracking, {
          format: 'CODE128',
          height: 60,
          width: 2,
          displayValue: true,
          fontSize: 14,
          margin: 4,
          background: '#ffffff',
          lineColor: '#000000'
        });
      } catch (e) { /* ignore */ }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-icon no-print';
      delBtn.textContent = 'ลบ';
      delBtn.addEventListener('click', function () {
        items.splice(idx, 1);
        save();
        render();
      });

      wrap.appendChild(svg);
      wrap.appendChild(delBtn);
      tdBarcode.appendChild(wrap);
      tr.appendChild(tdBarcode);

      itemsBody.appendChild(tr);
    });
  }
})();
