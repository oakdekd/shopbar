(function () {
  const cfg = window.SHOPBAR_CONFIG || {};
  const sb = window.supabase && cfg.SUPABASE_URL
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        realtime: { params: { eventsPerSecond: 5 } }
      })
    : null;

  const form = document.getElementById('add-form');
  const nameInput = document.getElementById('product-name');
  const trackingInput = document.getElementById('tracking');
  const itemsBody = document.getElementById('items-body');
  const emptyState = document.getElementById('empty-state');
  const printBtn = document.getElementById('print-btn');
  const clearBtn = document.getElementById('clear-btn');
  const pasteBtn = document.getElementById('paste-btn');
  const nameSuggestList = document.getElementById('name-suggestions');
  const syncStatus = document.getElementById('sync-status');
  const syncText = syncStatus.querySelector('.sync-text');

  const ITEMS_CACHE = 'shopbarcode.items.v3';
  const NAMES_CACHE = 'shopbarcode.names.v2';
  const NAMES_LIMIT = 200;
  const SENTINEL_ID = '00000000-0000-0000-0000-000000000000';

  let items = loadCache(ITEMS_CACHE, []);
  let nameHistory = loadCache(NAMES_CACHE, []);

  render();
  renderNameSuggestions();

  if (!sb) {
    setSync('error', 'ออฟไลน์');
  } else {
    init();
  }

  async function init() {
    setSync('syncing', 'กำลังโหลด…');
    await migrateLocalIfNeeded();
    await Promise.all([fetchItems(), fetchNames()]);
    setSync('online', 'ออนไลน์');
    subscribe();
    window.addEventListener('online', refresh);
    window.addEventListener('offline', () => setSync('error', 'ออฟไลน์'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }

  async function refresh() {
    setSync('syncing', 'กำลังซิงค์…');
    await Promise.all([fetchItems(), fetchNames()]);
    setSync('online', 'ออนไลน์');
  }

  function subscribe() {
    sb.channel('shopbar-items')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => {
        fetchItems();
      })
      .subscribe();
    sb.channel('shopbar-names')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_names' }, () => {
        fetchNames();
      })
      .subscribe();
  }

  async function migrateLocalIfNeeded() {
    try {
      const migratedKey = 'shopbarcode.migrated.v3';
      if (localStorage.getItem(migratedKey)) return;

      const v2raw = localStorage.getItem('shopbarcode.items.v2');
      const v1raw = localStorage.getItem('shopbarcode.items.v1');
      const oldItems = JSON.parse(v2raw || v1raw || '[]');

      if (Array.isArray(oldItems) && oldItems.length > 0) {
        const payload = oldItems
          .filter(it => it && it.name && it.tracking)
          .map(it => ({
            name: String(it.name).trim(),
            tracking: String(it.tracking).trim(),
            packed: !!it.packed
          }));
        if (payload.length > 0) {
          await sb.from('items').insert(payload);
          // also seed names
          const names = payload.map(p => ({ name: p.name, used_at: new Date().toISOString() }));
          await sb.from('product_names').upsert(names, { onConflict: 'name' });
        }
      }

      const v1namesRaw = localStorage.getItem('shopbarcode.names.v1');
      if (v1namesRaw) {
        try {
          const arr = JSON.parse(v1namesRaw);
          if (Array.isArray(arr) && arr.length > 0) {
            const names = arr
              .filter(n => typeof n === 'string' && n.trim())
              .map(n => ({ name: n.trim(), used_at: new Date().toISOString() }));
            if (names.length) await sb.from('product_names').upsert(names, { onConflict: 'name' });
          }
        } catch (e) { /* ignore */ }
      }

      localStorage.setItem(migratedKey, '1');
    } catch (e) {
      console.warn('migration skipped:', e);
    }
  }

  async function fetchItems() {
    if (!sb) return;
    const { data, error } = await sb
      .from('items')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { setSync('error', 'โหลดไม่สำเร็จ'); return; }
    items = data || [];
    saveCache(ITEMS_CACHE, items);
    render();
  }

  async function fetchNames() {
    if (!sb) return;
    const { data, error } = await sb
      .from('product_names')
      .select('name')
      .order('used_at', { ascending: false })
      .limit(NAMES_LIMIT);
    if (error) return;
    nameHistory = (data || []).map(r => r.name);
    saveCache(NAMES_CACHE, nameHistory);
    renderNameSuggestions();
  }

  /* ---------- Mutations ---------- */

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const name = nameInput.value.trim();
    const tracking = trackingInput.value.trim();
    if (!name || !tracking) return;

    // Optimistic
    const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
    const optimistic = {
      id: tempId,
      name, tracking, packed: false,
      created_at: new Date().toISOString(),
      _pending: true
    };
    items.push(optimistic);
    render();
    form.reset();
    nameInput.focus();

    if (!sb) return;
    setSync('syncing', 'กำลังบันทึก…');
    const { data, error } = await sb
      .from('items')
      .insert({ name, tracking, packed: false })
      .select()
      .single();
    if (error) {
      items = items.filter(it => it.id !== tempId);
      render();
      setSync('error', 'บันทึกไม่สำเร็จ');
      alert('บันทึกไม่สำเร็จ: ' + error.message);
      return;
    }
    const idx = items.findIndex(it => it.id === tempId);
    if (idx >= 0) items[idx] = data;
    saveCache(ITEMS_CACHE, items);
    render();
    setSync('online', 'ออนไลน์');

    // Remember name (server)
    sb.from('product_names')
      .upsert({ name, used_at: new Date().toISOString() }, { onConflict: 'name' })
      .then(() => { /* realtime will refresh */ });
  });

  clearBtn.addEventListener('click', async function () {
    if (items.length === 0) return;
    if (!confirm('ลบรายการทั้งหมด?')) return;
    const prev = items.slice();
    items = [];
    render();
    if (!sb) return;
    setSync('syncing', 'กำลังลบ…');
    const { error } = await sb.from('items').delete().neq('id', SENTINEL_ID);
    if (error) {
      items = prev;
      render();
      setSync('error', 'ลบไม่สำเร็จ');
      alert('ลบไม่สำเร็จ: ' + error.message);
      return;
    }
    saveCache(ITEMS_CACHE, items);
    setSync('online', 'ออนไลน์');
  });

  printBtn.addEventListener('click', function () {
    if (items.length === 0) {
      alert('ยังไม่มีรายการ เพิ่มสินค้าก่อนพิมพ์');
      return;
    }
    window.print();
  });

  async function togglePacked(id) {
    const idx = items.findIndex(it => it.id === id);
    if (idx < 0) return;
    const next = !items[idx].packed;
    items[idx].packed = next;
    saveCache(ITEMS_CACHE, items);
    render();
    if (!sb || String(id).startsWith('temp-')) return;
    const { error } = await sb.from('items').update({ packed: next }).eq('id', id);
    if (error) {
      items[idx].packed = !next;
      render();
      setSync('error', 'อัพเดทไม่สำเร็จ');
    }
  }

  async function deleteItem(id) {
    const prev = items.slice();
    items = items.filter(it => it.id !== id);
    saveCache(ITEMS_CACHE, items);
    render();
    if (!sb || String(id).startsWith('temp-')) return;
    const { error } = await sb.from('items').delete().eq('id', id);
    if (error) {
      items = prev;
      render();
      setSync('error', 'ลบไม่สำเร็จ');
    }
  }

  /* ---------- Paste ---------- */

  pasteBtn.addEventListener('click', async function () {
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (e) { /* ignore */ }

    if (text && text.trim()) {
      applyPastedTracking(text.trim());
      return;
    }
    trackingInput.focus();
    trackingInput.select();
  });

  trackingInput.addEventListener('paste', function (e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const text = (cd.getData('text') || '').trim();
    if (!text) return;
    e.preventDefault();
    applyPastedTracking(text);
  });

  function applyPastedTracking(text) {
    trackingInput.value = text;
    flashPasteSuccess();
    if (nameInput.value.trim()) {
      setTimeout(() => {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }, 120);
    } else {
      nameInput.focus();
    }
  }

  function flashPasteSuccess() {
    pasteBtn.classList.add('is-success');
    trackingInput.classList.add('is-flash');
    setTimeout(() => {
      pasteBtn.classList.remove('is-success');
      trackingInput.classList.remove('is-flash');
    }, 600);
  }

  /* ---------- Render ---------- */

  function render() {
    itemsBody.innerHTML = '';

    if (items.length === 0) {
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';

    items.forEach((item, idx) => {
      const tr = document.createElement('tr');
      if (item._pending) tr.classList.add('is-pending-row');

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
      badge.addEventListener('click', () => togglePacked(item.id));
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
      delBtn.addEventListener('click', () => deleteItem(item.id));

      wrap.appendChild(svg);
      wrap.appendChild(delBtn);
      tdBarcode.appendChild(wrap);
      tr.appendChild(tdBarcode);

      itemsBody.appendChild(tr);
    });
  }

  function renderNameSuggestions() {
    nameSuggestList.innerHTML = '';
    nameHistory.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      nameSuggestList.appendChild(opt);
    });
  }

  /* ---------- Utils ---------- */

  function loadCache(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function setSync(state, text) {
    syncStatus.classList.remove('is-online', 'is-syncing', 'is-error');
    syncStatus.classList.add('is-' + state);
    syncText.textContent = text;
  }
})();
