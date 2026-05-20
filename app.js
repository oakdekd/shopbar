(function () {
  const form = document.getElementById('add-form');
  const nameInput = document.getElementById('product-name');
  const trackingInput = document.getElementById('tracking');
  const itemsBody = document.getElementById('items-body');
  const emptyState = document.getElementById('empty-state');
  const printBtn = document.getElementById('print-btn');
  const clearBtn = document.getElementById('clear-btn');
  const printArea = document.getElementById('print-area');

  const STORAGE_KEY = 'shopbarcode.items.v1';

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
      tracking: tracking
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
    buildPrintArea();
    window.print();
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
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
      tr.appendChild(tdNo);

      const tdName = document.createElement('td');
      const nameDiv = document.createElement('div');
      nameDiv.className = 'item-name';
      nameDiv.textContent = item.name;
      const trackDiv = document.createElement('div');
      trackDiv.className = 'item-tracking';
      trackDiv.textContent = item.tracking;
      tdName.appendChild(nameDiv);
      tdName.appendChild(trackDiv);
      tr.appendChild(tdName);

      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.textContent = 'พร้อมพิมพ์';
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      const tdBarcode = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'barcode-cell';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      try {
        JsBarcode(svg, item.tracking, {
          format: 'CODE128',
          height: 44,
          width: 1.6,
          displayValue: true,
          fontSize: 12,
          margin: 4,
          background: '#ffffff',
          lineColor: '#000000'
        });
      } catch (e) { /* ignore */ }

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-icon';
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

  function buildPrintArea() {
    printArea.innerHTML = '';
    items.forEach((item) => {
      const label = document.createElement('div');
      label.className = 'print-label';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      try {
        JsBarcode(svg, item.tracking, {
          format: 'CODE128',
          height: 90,
          width: 2.4,
          displayValue: false,
          margin: 4,
          background: '#ffffff',
          lineColor: '#000000'
        });
      } catch (e) { /* ignore */ }

      const tracking = document.createElement('div');
      tracking.className = 'tracking';
      tracking.textContent = item.tracking;

      label.appendChild(name);
      label.appendChild(svg);
      label.appendChild(tracking);
      printArea.appendChild(label);
    });
  }
})();
