(function () {
  const C = window.ShopCommon;
  const { sb, shop, esc, money, fmtTime, fmtDate, imgOf, STATUS, toast, compressImage } = C;
  const $ = id => document.getElementById(id);

  if (!sb) {
    $('login-error').textContent = 'ไม่พบการตั้งค่า Supabase (config.js)';
    $('login-error').hidden = false;
    return;
  }

  const state = {
    user: null,
    products: [],
    orders: [],
    threads: [],
    activeThread: null,
    messages: [],
    tab: 'products',
    formImages: [],       // [{url}] รูปแรก = รูปหลัก
    channels: []
  };

  $('brand-name').textContent = shop.SHOP_NAME;
  document.title = 'หลังร้าน — ' + shop.SHOP_NAME;
  $('cat-list').innerHTML = (shop.CATEGORIES || []).map(c => `<option value="${esc(c)}">`).join('');

  // ---------- Auth ----------
  sb.auth.onAuthStateChange((_e, session) => {
    if (session) sb.realtime.setAuth(session.access_token);
  });

  (async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (session && !session.user.is_anonymous) await afterLogin(session.user);
    else showView('login');
  })();

  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const err = $('login-error');
    err.hidden = true;
    $('login-btn').disabled = true;
    // ถ้ามี session ลูกค้า (anonymous) ค้างอยู่ ให้ออกก่อน
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user.is_anonymous) await sb.auth.signOut();
    const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    $('login-btn').disabled = false;
    if (error) {
      err.textContent = /invalid/i.test(error.message) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : error.message;
      err.hidden = false;
      return;
    }
    f.password.value = '';
    await afterLogin(data.user);
  });

  async function afterLogin(user) {
    state.user = user;
    const { data: isAdmin, error } = await sb.rpc('is_shop_admin');
    if (error) {
      showView('login');
      $('login-error').textContent = 'ตรวจสอบสิทธิ์ไม่ได้: ' + error.message + ' (รัน shop/schema.sql แล้วหรือยัง?)';
      $('login-error').hidden = false;
      return;
    }
    if (!isAdmin) {
      $('not-admin-email').textContent = user.email;
      $('not-admin-sql').textContent =
        `insert into public.shop_admins (user_id)\nselect id from auth.users where email = '${user.email}'\non conflict do nothing;`;
      showView('not-admin');
      return;
    }
    $('admin-email').textContent = user.email;
    showView('admin');
    await Promise.all([loadProducts(), loadOrders(), loadThreads()]);
    subscribeAll();
  }

  function showView(v) {
    $('login-view').hidden = v !== 'login';
    $('not-admin-view').hidden = v !== 'not-admin';
    $('admin-view').hidden = v !== 'admin';
    $('topbar-user').hidden = v === 'login';
  }

  async function logout() {
    state.channels.forEach(ch => sb.removeChannel(ch));
    state.channels = [];
    await sb.auth.signOut();
    state.user = null;
    showView('login');
  }
  $('logout-btn').addEventListener('click', logout);
  $('logout-btn-2').addEventListener('click', logout);
  $('recheck-btn').addEventListener('click', () => afterLogin(state.user));

  // ---------- Tabs ----------
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  }

  // ---------- Realtime ----------
  function subscribeAll() {
    let pt = null, ot = null;
    state.channels.push(
      sb.channel('admin-products')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => { clearTimeout(pt); pt = setTimeout(loadProducts, 400); })
        .subscribe(),
      sb.channel('admin-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, payload => {
          clearTimeout(ot); ot = setTimeout(loadOrders, 400);
          if (payload.eventType === 'INSERT') toast('🧾 มีคำสั่งซื้อใหม่ #' + payload.new.id, 'success');
        })
        .subscribe(),
      sb.channel('admin-threads')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_threads' }, () => loadThreads())
        .subscribe(),
      sb.channel('admin-messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
          const m = payload.new;
          if (state.activeThread && m.thread_id === state.activeThread.id) {
            if (state.messages.some(x => x.id === m.id)) return;
            const idx = state.messages.findIndex(x => x.pending && x.sender === m.sender && x.body === m.body);
            if (idx >= 0) state.messages[idx] = m; else state.messages.push(m);
            renderMessages();
            if (m.sender === 'customer') markThreadRead(m.thread_id);
          } else if (m.sender === 'customer') {
            toast('💬 ข้อความใหม่จากลูกค้า');
          }
        })
        .subscribe()
    );
  }

  // ---------- Products ----------
  async function loadProducts() {
    const { data, error } = await sb.from('products').select('*').order('created_at', { ascending: false });
    if (error) return toast('โหลดสินค้าไม่ได้: ' + error.message, 'error');
    state.products = data || [];
    renderProducts();
  }

  function renderProducts() {
    const q = $('prod-search').value.trim().toLowerCase();
    const filter = $('prod-filter').value;
    const list = state.products.filter(p => {
      if (q && !(p.name + ' ' + p.category).toLowerCase().includes(q)) return false;
      if (filter === 'active' && !p.is_active) return false;
      if (filter === 'inactive' && p.is_active) return false;
      if (filter === 'low' && p.stock > 3) return false;
      return true;
    });
    $('prod-empty').hidden = list.length > 0;
    $('prod-body').innerHTML = list.map(p => `
      <tr class="${p.is_active ? '' : 'inactive'}" data-id="${p.id}">
        <td><img class="thumb" src="${esc(imgOf(p))}" alt="" /></td>
        <td><div style="font-weight:600">${esc(p.name)}</div><div class="muted" style="font-size:12px">${esc(p.category)}</div></td>
        <td><span class="price">${money(p.price)}</span>${p.compare_price ? `<br><span class="compare">${money(p.compare_price)}</span>` : ''}</td>
        <td><span class="pill ${p.stock <= 3 ? 'low' : ''}">${p.stock}</span></td>
        <td>${p.sold_count}</td>
        <td><span class="pill ${p.is_active ? 'on' : ''}">${p.is_active ? 'เปิดขาย' : 'ปิด'}</span></td>
        <td class="actions">
          <button type="button" class="btn btn-neutral btn-sm" data-act="edit">แก้ไข</button>
          <button type="button" class="btn btn-neutral btn-sm" data-act="toggle">${p.is_active ? 'ปิดขาย' : 'เปิดขาย'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="delete">ลบ</button>
        </td>
      </tr>`).join('');
  }
  $('prod-search').addEventListener('input', renderProducts);
  $('prod-filter').addEventListener('change', renderProducts);

  $('prod-body').addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    if (btn.dataset.act === 'edit') openProductForm(p);
    if (btn.dataset.act === 'toggle') {
      const { error } = await sb.from('products').update({ is_active: !p.is_active }).eq('id', id);
      if (error) toast(error.message, 'error'); else loadProducts();
    }
    if (btn.dataset.act === 'delete') {
      if (!confirm(`ลบสินค้า "${p.name}" ?\n(ถ้าเคยขายแล้ว แนะนำให้ "ปิดขาย" แทน)`)) return;
      const { error } = await sb.from('products').delete().eq('id', id);
      if (error) toast(error.message, 'error'); else { toast('ลบแล้ว'); loadProducts(); }
    }
  });

  $('add-product-btn').addEventListener('click', () => openProductForm(null));

  function openProductForm(p) {
    const f = $('product-form');
    f.reset();
    $('product-error').hidden = true;
    $('upload-progress').textContent = '';
    $('product-modal-title').textContent = p ? 'แก้ไขสินค้า' : 'เพิ่มสินค้า';
    f.id.value = p ? p.id : '';
    if (p) {
      f.name.value = p.name;
      f.price.value = p.price;
      f.compare_price.value = p.compare_price || '';
      f.category.value = p.category || '';
      f.stock.value = p.stock;
      f.description.value = p.description || '';
      f.is_active.checked = !!p.is_active;
      state.formImages = [p.image_url].concat(Array.isArray(p.images) ? p.images : []).filter(Boolean);
    } else {
      state.formImages = [];
      f.stock.value = 10;
      f.is_active.checked = true;
    }
    renderImagePicker();
    showModal('product-modal');
    f.name.focus();
  }

  function renderImagePicker() {
    $('img-picker').innerHTML = state.formImages.map((u, i) => `
      <div class="thumb-box ${i === 0 ? 'main' : ''}" data-i="${i}" title="${i === 0 ? 'รูปหลัก' : 'แตะเพื่อตั้งเป็นรูปหลัก'}">
        <img src="${esc(u)}" alt="" />
        <button type="button" data-remove="${i}" aria-label="ลบรูป">×</button>
      </div>`).join('') +
      `<label class="add">+ อัปโหลดรูป<input type="file" id="img-files" accept="image/*" multiple /></label>`;
    $('img-files').addEventListener('change', uploadFiles);
  }

  $('img-picker').addEventListener('click', e => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { state.formImages.splice(Number(rm.dataset.remove), 1); renderImagePicker(); return; }
    const box = e.target.closest('.thumb-box');
    if (box) {
      const i = Number(box.dataset.i);
      if (i > 0) { const [u] = state.formImages.splice(i, 1); state.formImages.unshift(u); renderImagePicker(); }
    }
  });

  $('img-url-add').addEventListener('click', () => {
    const inp = $('img-url-input');
    const u = inp.value.trim();
    if (!/^https?:\/\//i.test(u)) return toast('ลิงก์รูปต้องขึ้นต้นด้วย http(s)://', 'error');
    state.formImages.push(u);
    inp.value = '';
    renderImagePicker();
  });

  async function uploadFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const prog = $('upload-progress');
    const save = $('product-save');
    save.disabled = true;
    let n = 0;
    for (const file of files) {
      n++;
      prog.textContent = `กำลังอัปโหลดรูป ${n}/${files.length}…`;
      try {
        const blob = await compressImage(file, 1000, 0.85);
        const path = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await sb.storage.from('product-images').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
        if (error) throw error;
        const { data } = sb.storage.from('product-images').getPublicUrl(path);
        state.formImages.push(data.publicUrl);
        renderImagePicker();
      } catch (err) {
        toast('อัปโหลดไม่สำเร็จ: ' + err.message, 'error');
      }
    }
    prog.textContent = '';
    save.disabled = false;
  }

  $('product-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const err = $('product-error');
    err.hidden = true;
    const name = f.name.value.trim();
    const price = Number(f.price.value);
    if (!name || !(price >= 0) || f.price.value === '') {
      err.textContent = 'กรุณากรอกชื่อสินค้าและราคาให้ถูกต้อง';
      err.hidden = false;
      return;
    }
    const cmp = f.compare_price.value === '' ? null : Number(f.compare_price.value);
    const payload = {
      name,
      price,
      compare_price: cmp && cmp > price ? cmp : null,
      category: f.category.value.trim() || 'ทั่วไป',
      stock: Math.max(0, Number(f.stock.value) | 0),
      description: f.description.value.trim(),
      image_url: state.formImages[0] || null,
      images: state.formImages.slice(1),
      is_active: f.is_active.checked
    };
    $('product-save').disabled = true;
    const q = f.id.value
      ? sb.from('products').update(payload).eq('id', f.id.value)
      : sb.from('products').insert(payload);
    const { error } = await q;
    $('product-save').disabled = false;
    if (error) {
      err.textContent = 'บันทึกไม่สำเร็จ: ' + error.message;
      err.hidden = false;
      return;
    }
    toast(f.id.value ? 'บันทึกแล้ว' : 'เพิ่มสินค้าแล้ว', 'success');
    closeModal('product-modal');
    loadProducts();
  });

  // ---------- Orders ----------
  async function loadOrders() {
    const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) return toast('โหลดคำสั่งซื้อไม่ได้: ' + error.message, 'error');
    state.orders = data || [];
    const newCount = state.orders.filter(o => o.status === 'new').length;
    $('orders-new-count').textContent = newCount;
    $('orders-new-count').hidden = newCount === 0;
    renderOrders();
  }

  function renderOrders() {
    const filter = $('order-filter').value;
    const list = state.orders.filter(o => {
      if (filter === 'all') return true;
      if (filter === 'open') return ['new', 'confirmed', 'shipping'].includes(o.status);
      return o.status === filter;
    });
    $('order-empty').hidden = list.length > 0;
    $('order-body').innerHTML = list.map(o => `
      <tr data-id="${o.id}">
        <td><strong>#${o.id}</strong><br><small class="muted">${fmtDate(o.created_at)}</small></td>
        <td class="order-row-detail">
          <div><strong>${esc(o.customer_name)}</strong> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></div>
          <div class="addr">${esc(o.district)} — ${esc(o.address)}</div>
          ${o.note ? `<div>📝 ${esc(o.note)}</div>` : ''}
        </td>
        <td class="order-row-detail">${(o.items || []).map(i => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td>
        <td><strong class="price">${money(o.total)}</strong><br><small class="muted">ส่ง ${o.delivery_fee > 0 ? money(o.delivery_fee) : 'ฟรี'} · ${o.payment === 'cod' ? 'ปลายทาง' : 'โอน'}</small></td>
        <td>
          <select class="status-select" data-order="${o.id}">
            ${Object.keys(STATUS).map(k => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${STATUS[k].label}</option>`).join('')}
          </select>
        </td>
        <td class="actions"><button type="button" class="btn btn-neutral btn-sm" data-act="chat">💬 แชท</button></td>
      </tr>`).join('');
  }
  $('order-filter').addEventListener('change', renderOrders);
  $('orders-refresh').addEventListener('click', loadOrders);

  $('order-body').addEventListener('change', async e => {
    const sel = e.target.closest('.status-select');
    if (!sel) return;
    const id = Number(sel.dataset.order);
    const o = state.orders.find(x => x.id === id);
    if (sel.value === 'cancelled' && !confirm(`ยกเลิกคำสั่งซื้อ #${id}? (สต๊อกจะคืนกลับ)`)) { sel.value = o.status; return; }
    const { error } = await sb.from('orders').update({ status: sel.value }).eq('id', id);
    if (error) { toast(error.message, 'error'); sel.value = o.status; return; }
    toast(`#${id} → ${STATUS[sel.value].label}`, 'success');
    loadOrders();
  });
  $('order-body').addEventListener('click', e => {
    const btn = e.target.closest('[data-act="chat"]');
    if (!btn) return;
    const id = Number(btn.closest('tr').dataset.id);
    const o = state.orders.find(x => x.id === id);
    if (o) { switchTab('chat'); openThread(o.thread_id, o.customer_name); }
  });

  // ---------- Chat ----------
  async function loadThreads() {
    const { data, error } = await sb.from('chat_threads').select('*').order('updated_at', { ascending: false }).limit(200);
    if (error) return toast('โหลดแชทไม่ได้: ' + error.message, 'error');
    state.threads = data || [];
    const unread = state.threads.reduce((s, t) => s + (t.unread_shop || 0), 0);
    $('chat-unread-count').textContent = unread;
    $('chat-unread-count').hidden = unread === 0;
    renderThreads();
  }

  function renderThreads() {
    const el = $('threads');
    if (!state.threads.length) { el.innerHTML = '<div class="empty">ยังไม่มีแชท</div>'; return; }
    el.innerHTML = state.threads.map(t => `
      <button type="button" class="thread ${state.activeThread && state.activeThread.id === t.id ? 'active' : ''} ${t.unread_shop > 0 ? 'unread' : ''}" data-id="${t.id}">
        <span class="t-name">${esc(t.customer_name || 'ลูกค้า ' + t.id.slice(0, 6))}</span>
        <span class="t-time">${fmtTime(t.updated_at)}</span>
        <span class="t-last">${t.last_sender === 'shop' ? 'คุณ: ' : ''}${esc(t.last_message || '')}</span>
        ${t.unread_shop > 0 ? `<span class="t-unread">${t.unread_shop}</span>` : ''}
      </button>`).join('');
  }

  $('threads').addEventListener('click', e => {
    const b = e.target.closest('.thread');
    if (b) openThread(b.dataset.id);
  });
  $('inbox-back').addEventListener('click', () => { $('inbox').classList.remove('show-convo'); });

  async function openThread(id, fallbackName) {
    let t = state.threads.find(x => x.id === id);
    if (!t) {
      // ห้องอาจยังไม่ถูกโหลด (เช่น เพิ่งสร้าง) — สร้างให้เมื่อกดจากออเดอร์
      await sb.from('chat_threads').upsert({ id, customer_name: fallbackName || null }, { onConflict: 'id', ignoreDuplicates: true });
      await loadThreads();
      t = state.threads.find(x => x.id === id) || { id, customer_name: fallbackName };
    }
    state.activeThread = t;
    $('inbox').classList.add('show-convo');
    $('convo-empty').hidden = true;
    $('convo-head').hidden = false;
    $('convo-messages').hidden = false;
    $('convo-form').hidden = false;
    $('convo-name').textContent = t.customer_name || 'ลูกค้า ' + id.slice(0, 6);
    const orders = state.orders.filter(o => o.thread_id === id);
    $('convo-sub').textContent = orders.length
      ? `${orders.length} คำสั่งซื้อ · ล่าสุด ${orders[0].phone} · ${orders[0].district}`
      : 'ยังไม่มีคำสั่งซื้อ';
    renderThreads();
    state.messages = [];
    renderMessages();
    const { data, error } = await sb.from('chat_messages').select('*').eq('thread_id', id).order('id', { ascending: true }).limit(500);
    if (error) return toast(error.message, 'error');
    if (state.activeThread.id !== id) return;
    state.messages = data || [];
    renderMessages();
    markThreadRead(id);
    $('convo-input').focus();
  }

  function markThreadRead(id) {
    sb.from('chat_threads').update({ unread_shop: 0 }).eq('id', id).gt('unread_shop', 0).then(() => {});
  }

  function renderMessages() {
    const box = $('convo-messages');
    box.innerHTML = state.messages.map(m => {
      const mine = m.sender === 'shop';
      const p = m.product_id ? state.products.find(x => x.id === m.product_id) : null;
      return `<div class="msg ${mine ? 'me' : 'them'} ${m.pending ? 'pending' : ''}">
        ${p ? `<div class="msg-product"><img src="${esc(imgOf(p))}" alt="" /><span>${esc(p.name)}<br><b>${money(p.price)}</b></span></div>` : ''}${esc(m.body)}<time>${fmtTime(m.created_at)}</time></div>`;
    }).join('') || '<div class="chat-welcome">ยังไม่มีข้อความ</div>';
    box.scrollTop = box.scrollHeight;
  }

  $('convo-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('convo-input');
    const body = input.value.trim();
    const t = state.activeThread;
    if (!body || !t) return;
    input.value = '';
    const temp = { id: 'tmp-' + Date.now(), sender: 'shop', body, created_at: new Date().toISOString(), pending: true };
    state.messages.push(temp);
    renderMessages();
    const { data, error } = await sb.from('chat_messages').insert({ thread_id: t.id, sender: 'shop', body }).select('*').single();
    if (error) {
      state.messages = state.messages.filter(m => m !== temp);
      renderMessages();
      input.value = body;
      return toast('ส่งไม่สำเร็จ: ' + error.message, 'error');
    }
    const idx = state.messages.indexOf(temp);
    if (idx >= 0) {
      if (state.messages.some(m => m.id === data.id)) state.messages.splice(idx, 1);
      else state.messages[idx] = data;
      renderMessages();
    }
  });

  $('convo-orders-btn').addEventListener('click', () => {
    const t = state.activeThread;
    if (!t) return;
    const orders = state.orders.filter(o => o.thread_id === t.id);
    $('order-modal-title').textContent = 'คำสั่งซื้อของ ' + (t.customer_name || 'ลูกค้า');
    $('order-modal-body').innerHTML = orders.length ? orders.map(o => {
      const st = STATUS[o.status] || STATUS.new;
      return `<div class="order-card">
        <div class="order-head"><strong>#${o.id}</strong><span class="status ${st.cls}">${st.label}</span></div>
        <ul class="order-items">${(o.items || []).map(i => `<li><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></li>`).join('')}</ul>
        <div class="order-total"><span>รวม</span><span>${money(o.total)}</span></div>
        <div class="order-sub">${fmtDate(o.created_at)} · ${esc(o.phone)} · ${esc(o.district)} — ${esc(o.address)}${o.note ? ' · 📝 ' + esc(o.note) : ''}</div>
      </div>`;
    }).join('') : '<div class="empty">ยังไม่มีคำสั่งซื้อ</div>';
    showModal('order-modal');
  });

  // ---------- Modals ----------
  function showModal(id) { $(id).hidden = false; document.body.classList.add('no-scroll'); }
  function closeModal(id) {
    $(id).hidden = true;
    if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('no-scroll');
  }
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]');
    if (!c) return;
    const wrap = c.closest('.modal');
    if (wrap) closeModal(wrap.id);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal:not([hidden])');
    if (open) closeModal(open.id);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.user && !$('admin-view').hidden) { loadOrders(); loadThreads(); }
  });
})();
