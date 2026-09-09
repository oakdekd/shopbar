(function () {
  const C = window.ShopCommon;
  const { sb, shop, esc, money, fmtTime, fmtDate, imgOf, discountPct, STATUS, toast } = C;

  const CART_KEY = 'shopbar.cart.v1';
  const NAME_KEY = 'shopbar.customer.v1';

  const state = {
    products: [],
    cart: loadJSON(CART_KEY, []),
    customer: loadJSON(NAME_KEY, {}),
    category: 'all',
    sort: 'newest',
    query: '',
    user: null,
    authError: null,
    demo: false,
    chat: { open: false, loaded: false, messages: [], unread: 0, channel: null, threadChannel: null, pendingProduct: null }
  };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const grid = $('grid');
  const cartCount = $('cart-count');

  // ---------- Init (เรียกท้ายไฟล์ หลังประกาศทุกอย่างแล้ว) ----------
  function init() {
    applyConfig();
    renderCartBadge();
    bindGlobal();
    loadProducts();
    initAuth();
  }

  function applyConfig() {
    document.title = shop.SHOP_NAME + ' — ส่งถึงบ้านในชัยนาท';
    $('brand-name').textContent = shop.SHOP_NAME;
    $('footer-name').textContent = shop.SHOP_NAME;
    $('chat-shop-name').textContent = shop.SHOP_NAME;
    $('tagline-text').textContent = shop.TAGLINE.replace(/^ส่งเองถึงบ้าน\s*/, '');
    $('footer-tagline').textContent = shop.TAGLINE;
    const contact = [shop.PHONE && ('โทร ' + shop.PHONE), shop.LINE_ID && ('LINE ' + shop.LINE_ID)].filter(Boolean).join(' · ');
    $('footer-contact').textContent = contact;
    const d = shop.DELIVERY || {};
    $('free-ship-text').textContent = d.freeOver > 0
      ? 'ส่งฟรีเมื่อซื้อครบ ' + money(d.freeOver)
      : 'ค่าส่งเริ่มต้น ' + money(d.fee || 0);

    const sel = $('district-select');
    sel.innerHTML = '<option value="">— เลือกพื้นที่จัดส่ง —</option>' +
      (d.areas || []).map(a => `<option value="${esc(a.name)}">${esc(a.name)}${a.fee == null ? ' · สอบถามค่าส่ง' : ' · ค่าส่ง ' + money(a.fee)}</option>`).join('');
    if (state.customer.district) sel.value = state.customer.district;

    const f = $('checkout-form');
    if (state.customer.name) f.customer_name.value = state.customer.name;
    if (state.customer.phone) f.phone.value = state.customer.phone;
    if (state.customer.address) f.address.value = state.customer.address;
    $('chat-name-input').value = state.customer.name || '';
  }

  // ---------- Products ----------
  async function loadProducts() {
    if (!sb) return useDemo();
    const { data, error } = await sb
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('โหลดสินค้าไม่สำเร็จ:', error.message);
      return useDemo();
    }
    state.products = data || [];
    $('grid-loading').hidden = true;
    renderCategories();
    renderGrid();
    renderCart();
    openFromHash();
    subscribeProducts();
  }

  function useDemo() {
    state.demo = true;
    state.products = DEMO_PRODUCTS;
    $('demo-banner').hidden = false;
    $('grid-loading').hidden = true;
    renderCategories();
    renderGrid();
    renderCart();
  }

  let productsChannel = null;
  function subscribeProducts() {
    if (productsChannel) return;
    let t = null;
    productsChannel = sb.channel('store-products')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
        clearTimeout(t);
        t = setTimeout(refreshProducts, 400);
      })
      .subscribe();
  }

  async function refreshProducts() {
    const { data } = await sb.from('products').select('*').eq('is_active', true).order('created_at', { ascending: false });
    if (!data) return;
    state.products = data;
    renderCategories();
    renderGrid();
    renderCart();
  }

  function visibleProducts() {
    const q = state.query.trim().toLowerCase();
    let list = state.products.filter(p => {
      if (state.category !== 'all' && p.category !== state.category) return false;
      if (q && !(p.name + ' ' + (p.description || '') + ' ' + (p.category || '')).toLowerCase().includes(q)) return false;
      return true;
    });
    const by = {
      newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
      bestseller: (a, b) => (b.sold_count || 0) - (a.sold_count || 0),
      'price-asc': (a, b) => a.price - b.price,
      'price-desc': (a, b) => b.price - a.price
    }[state.sort];
    return list.sort(by);
  }

  function renderCategories() {
    const counts = {};
    state.products.forEach(p => { counts[p.category || 'ทั่วไป'] = (counts[p.category || 'ทั่วไป'] || 0) + 1; });
    const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const el = $('cats');
    el.innerHTML = [`<button type="button" class="cat-chip ${state.category === 'all' ? 'active' : ''}" data-cat="all">ทั้งหมด</button>`]
      .concat(cats.map(c => `<button type="button" class="cat-chip ${state.category === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} <span class="muted">(${counts[c]})</span></button>`))
      .join('');
  }

  function renderGrid() {
    const list = visibleProducts();
    $('grid-empty').hidden = list.length > 0;
    $('listing-title').textContent = state.query
      ? `ผลการค้นหา "${state.query}"`
      : state.category === 'all' ? 'สินค้าทั้งหมด' : state.category;
    grid.innerHTML = list.map(p => {
      const off = discountPct(p);
      const out = (p.stock | 0) <= 0;
      return `
        <button type="button" class="product" data-id="${p.id}" aria-label="${esc(p.name)}">
          <div class="product-img">
            <img src="${esc(imgOf(p))}" alt="" loading="lazy" />
            ${off ? `<span class="off">-${off}%</span>` : ''}
            ${out ? '<div class="soldout"><span>สินค้าหมด</span></div>' : ''}
          </div>
          <div class="product-info">
            <p class="product-name">${esc(p.name)}</p>
            <div class="product-price">
              <span class="price">${money(p.price)}</span>
              ${off ? `<span class="compare">${money(p.compare_price)}</span>` : ''}
            </div>
            <div class="product-meta">
              <span>ขายแล้ว ${p.sold_count || 0}</span>
              <span>📍 ชัยนาท</span>
            </div>
          </div>
        </button>`;
    }).join('');
  }

  // ---------- Product modal ----------
  let modalProduct = null;
  let modalQty = 1;

  function openProduct(id) {
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    modalProduct = p;
    modalQty = 1;
    const imgs = [p.image_url].concat(Array.isArray(p.images) ? p.images : []).filter(Boolean);
    if (!imgs.length) imgs.push(C.PLACEHOLDER_IMG);
    const off = discountPct(p);
    const out = (p.stock | 0) <= 0;
    $('pm-body').innerHTML = `
      <div class="pm-gallery">
        <div class="pm-main"><img id="pm-main-img" src="${esc(imgs[0])}" alt="${esc(p.name)}" /></div>
        ${imgs.length > 1 ? `<div class="pm-thumbs">${imgs.map((u, i) => `<img src="${esc(u)}" class="${i === 0 ? 'active' : ''}" data-src="${esc(u)}" alt="" />`).join('')}</div>` : ''}
      </div>
      <div class="pm-detail">
        <h2>${esc(p.name)}</h2>
        <div class="pm-price-box">
          ${off ? `<span class="compare">${money(p.compare_price)}</span>` : ''}
          <span class="price">${money(p.price)}</span>
          ${off ? `<span class="off-tag">ลด ${off}%</span>` : ''}
        </div>
        <div class="pm-meta">
          <span>หมวด: ${esc(p.category || 'ทั่วไป')}</span>
          <span>ขายแล้ว ${p.sold_count || 0}</span>
          <span>${out ? '<b style="color:#dc2626">สินค้าหมด</b>' : 'เหลือ ' + p.stock + ' ชิ้น'}</span>
        </div>
        <div class="pm-meta"><span>🚚 ส่งเองถึงบ้าน ในชัยนาทและใกล้เคียง</span></div>
        ${p.description ? `<div class="pm-desc">${esc(p.description)}</div>` : ''}
        <div class="qty-row">
          <span class="muted">จำนวน</span>
          <div class="qty">
            <button type="button" id="qty-dec" aria-label="ลด">−</button>
            <input type="number" id="qty-input" value="1" min="1" max="${Math.max(p.stock, 1)}" inputmode="numeric" />
            <button type="button" id="qty-inc" aria-label="เพิ่ม">+</button>
          </div>
        </div>
        <div class="pm-actions">
          <button type="button" class="btn btn-outline" id="pm-add" ${out ? 'disabled' : ''}>🛒 ใส่ตะกร้า</button>
          <button type="button" class="btn btn-primary" id="pm-buy" ${out ? 'disabled' : ''}>ซื้อเลย</button>
          <button type="button" class="btn btn-neutral btn-ask" id="pm-ask">💬 สอบถามสินค้านี้</button>
        </div>
      </div>`;
    showModal('product-modal');
    history.replaceState(null, '', '#p=' + p.id);

    const qtyInput = $('qty-input');
    const setQty = v => { modalQty = Math.min(Math.max(1, v | 0 || 1), Math.max(p.stock, 1)); qtyInput.value = modalQty; };
    $('qty-dec').onclick = () => setQty(modalQty - 1);
    $('qty-inc').onclick = () => setQty(modalQty + 1);
    qtyInput.onchange = () => setQty(Number(qtyInput.value));
    $('pm-add').onclick = () => { addToCart(p.id, modalQty); closeModal('product-modal'); openCart(); };
    $('pm-buy').onclick = () => { addToCart(p.id, modalQty, true); closeModal('product-modal'); openCheckout(); };
    $('pm-ask').onclick = () => { closeModal('product-modal'); openChat(p); };
    document.querySelectorAll('.pm-thumbs img').forEach(t => {
      t.onclick = () => {
        $('pm-main-img').src = t.dataset.src;
        document.querySelectorAll('.pm-thumbs img').forEach(x => x.classList.toggle('active', x === t));
      };
    });
  }

  function openFromHash() {
    const m = location.hash.match(/^#p=([0-9a-f-]{36})$/i);
    if (m) openProduct(m[1]);
  }

  // ---------- Cart ----------
  function saveCart() { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); }

  function addToCart(id, qty, silent) {
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    const line = state.cart.find(x => x.id === id);
    const max = Math.max(p.stock, 0);
    if (line) line.qty = Math.min(line.qty + qty, max);
    else state.cart.push({ id, qty: Math.min(qty, max) });
    saveCart();
    renderCart();
    if (!silent) toast('เพิ่ม "' + p.name + '" ลงตะกร้าแล้ว', 'success');
  }

  function cartLines() {
    const lines = [];
    state.cart = state.cart.filter(l => state.products.some(p => p.id === l.id));
    state.cart.forEach(l => {
      const p = state.products.find(x => x.id === l.id);
      if (l.qty > p.stock) l.qty = p.stock;
      if (l.qty > 0) lines.push({ ...l, product: p, amount: p.price * l.qty });
    });
    return lines;
  }

  function cartTotals(district) {
    const lines = cartLines();
    const subtotal = lines.reduce((s, l) => s + l.amount, 0);
    const d = shop.DELIVERY || {};
    const area = (d.areas || []).find(a => a.name === district);
    let fee = area ? area.fee : d.fee;
    let askFee = area ? area.fee == null : false;
    if (fee == null) fee = 0;
    if (d.freeOver > 0 && subtotal >= d.freeOver && !askFee) fee = 0;
    return { lines, subtotal, fee, askFee, total: subtotal + fee };
  }

  function renderCartBadge() {
    const n = state.cart.reduce((s, l) => s + l.qty, 0);
    cartCount.textContent = n;
    cartCount.hidden = n === 0;
  }

  function renderCart() {
    const t = cartTotals();
    renderCartBadge();
    const body = $('cart-body');
    const foot = $('cart-foot');
    if (!t.lines.length) {
      body.innerHTML = '<div class="empty">ตะกร้าว่างเปล่า<br><small>เลือกสินค้าที่ถูกใจแล้วกด "ใส่ตะกร้า"</small></div>';
      foot.innerHTML = '<button type="button" class="btn btn-primary btn-block" data-close>เลือกซื้อสินค้า</button>';
      return;
    }
    body.innerHTML = t.lines.map(l => `
      <div class="cart-item" data-id="${l.id}">
        <img src="${esc(imgOf(l.product))}" alt="" />
        <div>
          <p class="ci-name">${esc(l.product.name)}</p>
          <div class="ci-price">${money(l.product.price)}</div>
        </div>
        <div class="ci-side">
          <div class="qty">
            <button type="button" data-act="dec">−</button>
            <input type="number" value="${l.qty}" min="1" max="${l.product.stock}" data-act="set" inputmode="numeric" />
            <button type="button" data-act="inc">+</button>
          </div>
          <button type="button" class="link-danger" data-act="remove">ลบ</button>
        </div>
      </div>`).join('');
    const d = shop.DELIVERY || {};
    const need = d.freeOver > 0 ? d.freeOver - t.subtotal : 0;
    foot.innerHTML = `
      <div class="cart-sum"><span>ยอดสินค้า (${t.lines.reduce((s, l) => s + l.qty, 0)} ชิ้น)</span><span>${money(t.subtotal)}</span></div>
      <div class="cart-sum"><span>ค่าส่ง (เริ่มต้น)</span><span>${t.fee === 0 ? 'ฟรี' : money(t.fee)}</span></div>
      ${d.freeOver > 0 ? `<p class="free-ship-note">${need > 0 ? 'ซื้อเพิ่มอีก ' + money(need) + ' รับส่งฟรี 🚚' : '🎉 ได้รับส่งฟรีแล้ว'}</p>` : ''}
      <div class="cart-sum total"><span>รวมทั้งหมด</span><span>${money(t.total)}</span></div>
      <button type="button" class="btn btn-primary btn-block" id="go-checkout">ไปหน้าชำระเงิน</button>`;
    $('go-checkout').onclick = () => { closeModal('cart-drawer'); openCheckout(); };
  }

  function openCart() { renderCart(); showModal('cart-drawer'); }

  $('cart-body').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.cart-item').dataset.id;
    const line = state.cart.find(l => l.id === id);
    const p = state.products.find(x => x.id === id);
    if (!line || !p) return;
    const act = btn.dataset.act;
    if (act === 'inc') line.qty = Math.min(line.qty + 1, p.stock);
    if (act === 'dec') line.qty = Math.max(line.qty - 1, 1);
    if (act === 'remove') state.cart = state.cart.filter(l => l !== line);
    saveCart();
    renderCart();
  });
  $('cart-body').addEventListener('change', e => {
    const inp = e.target.closest('input[data-act="set"]');
    if (!inp) return;
    const id = inp.closest('.cart-item').dataset.id;
    const line = state.cart.find(l => l.id === id);
    const p = state.products.find(x => x.id === id);
    if (!line || !p) return;
    line.qty = Math.min(Math.max(Number(inp.value) | 0, 1), p.stock);
    saveCart();
    renderCart();
  });

  // ---------- Checkout ----------
  function openCheckout() {
    if (!cartLines().length) return toast('ตะกร้าว่างเปล่า');
    if (state.demo) return toast('โหมดตัวอย่าง: ยังสั่งซื้อไม่ได้ (ต้องตั้งค่า Supabase ก่อน)', 'error');
    renderCheckoutSummary();
    $('checkout-error').hidden = true;
    showModal('checkout-modal');
  }

  function renderCheckoutSummary() {
    const f = $('checkout-form');
    const t = cartTotals(f.district.value);
    $('checkout-summary').innerHTML =
      t.lines.map(l => `<div class="line"><span>${esc(l.product.name)} × ${l.qty}</span><span>${money(l.amount)}</span></div>`).join('') +
      `<div class="line"><span>ค่าส่ง</span><span>${t.askFee ? 'ร้านจะแจ้งทางแชท' : t.fee === 0 ? 'ฟรี' : money(t.fee)}</span></div>
       <div class="line total"><span>รวม${t.askFee ? ' (ไม่รวมค่าส่ง)' : ''}</span><span>${money(t.total)}</span></div>`;
    const hint = $('promptpay-hint');
    if (f.payment.value === 'transfer') {
      hint.hidden = false;
      hint.textContent = shop.PROMPTPAY
        ? 'โอนผ่านพร้อมเพย์ ' + shop.PROMPTPAY + ' แล้วส่งสลิปในแชท (หรือรอร้านยืนยันยอดก่อนก็ได้)'
        : 'หลังสั่งซื้อ ร้านจะแจ้งเลขบัญชี/พร้อมเพย์ให้ทางแชท';
    } else hint.hidden = true;
  }

  $('checkout-form').addEventListener('change', renderCheckoutSummary);
  $('checkout-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const err = $('checkout-error');
    err.hidden = true;
    const name = f.customer_name.value.trim();
    const phone = f.phone.value.trim();
    const district = f.district.value;
    const address = f.address.value.trim();
    if (!name || !phone || !district || !address) {
      err.textContent = 'กรุณากรอกข้อมูลที่มี * ให้ครบ';
      err.hidden = false;
      return;
    }
    if (!/^0\d{8,9}$/.test(phone.replace(/[-\s]/g, ''))) {
      err.textContent = 'เบอร์โทรไม่ถูกต้อง (เช่น 0812345678)';
      err.hidden = false;
      return;
    }
    const user = await ensureSession();
    if (!user) {
      err.textContent = 'เชื่อมต่อระบบไม่ได้: ' + (state.authError || 'ลองใหม่อีกครั้ง');
      err.hidden = false;
      return;
    }
    const t = cartTotals(district);
    const btn = $('checkout-submit');
    btn.disabled = true;
    btn.textContent = 'กำลังส่งคำสั่งซื้อ…';

    state.customer = { name, phone, district, address };
    localStorage.setItem(NAME_KEY, JSON.stringify(state.customer));

    const payload = {
      thread_id: user.id,
      customer_name: name,
      phone,
      district,
      address,
      note: f.note.value.trim() || null,
      payment: f.payment.value,
      delivery_fee: t.fee,
      items: t.lines.map(l => ({ id: l.id, qty: l.qty, name: l.product.name }))
    };
    const { data, error } = await sb.from('orders').insert(payload).select('id,total').single();
    btn.disabled = false;
    btn.textContent = 'สั่งซื้อ';
    if (error) {
      err.textContent = 'สั่งซื้อไม่สำเร็จ: ' + error.message;
      err.hidden = false;
      return;
    }
    state.cart = [];
    saveCart();
    renderCart();
    closeModal('checkout-modal');
    $('success-text').innerHTML = `หมายเลขคำสั่งซื้อ <strong>#${data.id}</strong> · ยอดรวม <strong>${money(data.total)}</strong>${t.askFee ? '<br><small>ร้านจะแจ้งค่าส่งเพิ่มเติมทางแชท</small>' : ''}`;
    showModal('success-modal');
    refreshProducts();
    if (state.chat.loaded) loadMessages();
    $('chat-name-input').value = name;
  });

  // ---------- My orders ----------
  async function openOrders() {
    showModal('orders-modal');
    const body = $('orders-body');
    body.innerHTML = '<div class="empty">กำลังโหลด…</div>';
    if (state.demo) { body.innerHTML = '<div class="empty">โหมดตัวอย่าง ยังไม่มีคำสั่งซื้อ</div>'; return; }
    const user = await ensureSession();
    if (!user) { body.innerHTML = '<div class="empty">เชื่อมต่อระบบไม่ได้</div>'; return; }
    const { data, error } = await sb.from('orders').select('*').eq('thread_id', user.id).order('created_at', { ascending: false }).limit(50);
    if (error) { body.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
    if (!data.length) { body.innerHTML = '<div class="empty">ยังไม่มีคำสั่งซื้อ</div>'; return; }
    body.innerHTML = data.map(o => {
      const st = STATUS[o.status] || STATUS.new;
      return `
        <div class="order-card">
          <div class="order-head"><strong>คำสั่งซื้อ #${o.id}</strong><span class="status ${st.cls}">${st.label}</span></div>
          <ul class="order-items">${(o.items || []).map(i => `<li><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price * i.qty)}</span></li>`).join('')}</ul>
          <div class="order-total"><span>รวม (ค่าส่ง ${o.delivery_fee > 0 ? money(o.delivery_fee) : 'ฟรี'})</span><span>${money(o.total)}</span></div>
          <div class="order-sub">${fmtDate(o.created_at)} · ${esc(o.district)} · ${o.payment === 'cod' ? 'เงินสดปลายทาง' : 'โอนเงิน'}</div>
        </div>`;
    }).join('');
  }

  // ---------- Auth (anonymous) ----------
  let sessionPromise = null;
  function initAuth() {
    if (!sb) return;
    sb.auth.onAuthStateChange((_evt, session) => {
      state.user = session ? session.user : null;
      if (session) sb.realtime.setAuth(session.access_token);
    });
    // เตรียม session ล่วงหน้า เพื่อโหลดจำนวนข้อความที่ยังไม่อ่าน
    ensureSession().then(u => { if (u) watchThread(); });
  }

  function ensureSession() {
    if (!sb) return Promise.resolve(null);
    if (state.user) return Promise.resolve(state.user);
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (session) { state.user = session.user; return session.user; }
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) {
        state.authError = /anonymous/i.test(error.message)
          ? 'ยังไม่ได้เปิด Anonymous sign-ins ใน Supabase'
          : error.message;
        console.warn('anonymous sign-in failed:', error.message);
        sessionPromise = null;
        return null;
      }
      state.user = data.user;
      return data.user;
    })();
    return sessionPromise;
  }

  // ---------- Chat ----------
  async function openChat(product) {
    state.chat.open = true;
    state.chat.pendingProduct = product || null;
    $('chat-panel').hidden = false;
    $('chat-fab').setAttribute('aria-expanded', 'true');
    if (product) {
      $('chat-input').value = 'สนใจสินค้า "' + product.name + '" ';
    }
    if (state.demo) {
      setChatNote('โหมดตัวอย่าง: แชทใช้งานได้หลังตั้งค่า Supabase');
      return;
    }
    const user = await ensureSession();
    if (!user) { setChatNote('เชื่อมต่อแชทไม่ได้: ' + (state.authError || 'ลองใหม่อีกครั้ง')); return; }
    if (!state.chat.loaded) {
      await ensureThread();
      await loadMessages();
      subscribeChat();
      state.chat.loaded = true;
    }
    markRead();
    $('chat-input').focus();
    scrollChat();
  }

  function closeChat() {
    state.chat.open = false;
    $('chat-panel').hidden = true;
    $('chat-fab').setAttribute('aria-expanded', 'false');
  }

  function setChatNote(text) {
    let el = document.querySelector('.chat-note');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'chat-note';
      $('chat-messages').before(el);
    }
    el.textContent = text;
  }

  async function ensureThread() {
    const name = $('chat-name-input').value.trim() || state.customer.name || null;
    const { error } = await sb.from('chat_threads').upsert({ id: state.user.id, customer_name: name }, { onConflict: 'id', ignoreDuplicates: !name });
    if (error) setChatNote('เปิดห้องแชทไม่ได้: ' + error.message);
    else setChatNote('');
  }

  async function loadMessages() {
    const { data, error } = await sb.from('chat_messages')
      .select('id,sender,body,product_id,created_at')
      .eq('thread_id', state.user.id)
      .order('id', { ascending: true })
      .limit(300);
    if (error) { setChatNote('โหลดข้อความไม่ได้: ' + error.message); return; }
    state.chat.messages = data || [];
    renderMessages();
  }

  function renderMessages() {
    const box = $('chat-messages');
    const html = state.chat.messages.map(m => {
      const mine = m.sender === 'customer';
      const p = m.product_id ? state.products.find(x => x.id === m.product_id) : null;
      return `<div class="msg ${mine ? 'me' : 'them'} ${m.pending ? 'pending' : ''}">
        ${p ? `<div class="msg-product"><img src="${esc(imgOf(p))}" alt="" /><span>${esc(p.name)}<br><b>${money(p.price)}</b></span></div>` : ''}${esc(m.body)}<time>${fmtTime(m.created_at)}</time></div>`;
    }).join('');
    box.innerHTML = '<div class="chat-welcome">สวัสดีครับ 👋 สอบถามสินค้า ค่าส่ง หรือเวลาจัดส่งได้เลย</div>' + html;
    scrollChat();
  }

  function scrollChat() {
    const box = $('chat-messages');
    box.scrollTop = box.scrollHeight;
  }

  function subscribeChat() {
    if (state.chat.channel) return;
    state.chat.channel = sb.channel('chat-' + state.user.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'thread_id=eq.' + state.user.id }, payload => {
        const m = payload.new;
        if (state.chat.messages.some(x => x.id === m.id)) return;
        const pendIdx = state.chat.messages.findIndex(x => x.pending && x.sender === m.sender && x.body === m.body);
        if (pendIdx >= 0) state.chat.messages[pendIdx] = m;
        else state.chat.messages.push(m);
        renderMessages();
        if (state.chat.open) markRead();
      })
      .subscribe();
  }

  function watchThread() {
    if (state.chat.threadChannel || !state.user) return;
    sb.from('chat_threads').select('unread_customer').eq('id', state.user.id).maybeSingle()
      .then(({ data }) => setUnread(data ? data.unread_customer : 0));
    state.chat.threadChannel = sb.channel('thread-' + state.user.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_threads', filter: 'id=eq.' + state.user.id }, payload => {
        setUnread(payload.new.unread_customer);
        if (payload.new.unread_customer > 0 && !state.chat.open && state.chat.loaded) loadMessages();
      })
      .subscribe();
  }

  function setUnread(n) {
    state.chat.unread = n | 0;
    const b = $('chat-unread');
    b.textContent = n;
    b.hidden = !(n > 0);
    if (n > 0 && state.chat.open) markRead();
  }

  let markTimer = null;
  function markRead() {
    if (!state.user) return;
    clearTimeout(markTimer);
    markTimer = setTimeout(() => {
      sb.from('chat_threads').update({ unread_customer: 0 }).eq('id', state.user.id).gt('unread_customer', 0).then(() => {});
      setUnreadLocal(0);
    }, 300);
  }
  function setUnreadLocal(n) {
    state.chat.unread = n;
    $('chat-unread').hidden = true;
  }

  $('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('chat-input');
    const body = input.value.trim();
    if (!body) return;
    if (state.demo) return toast('โหมดตัวอย่าง: ยังส่งข้อความไม่ได้', 'error');
    const user = await ensureSession();
    if (!user) return toast('เชื่อมต่อแชทไม่ได้', 'error');
    if (!state.chat.loaded) { await ensureThread(); await loadMessages(); subscribeChat(); state.chat.loaded = true; }

    const name = $('chat-name-input').value.trim();
    if (name && name !== state.customer.name) {
      state.customer.name = name;
      localStorage.setItem(NAME_KEY, JSON.stringify(state.customer));
      sb.from('chat_threads').update({ customer_name: name }).eq('id', user.id).then(() => {});
    }
    const product = state.chat.pendingProduct;
    state.chat.pendingProduct = null;
    input.value = '';
    const temp = { id: 'tmp-' + Date.now(), sender: 'customer', body, product_id: product ? product.id : null, created_at: new Date().toISOString(), pending: true };
    state.chat.messages.push(temp);
    renderMessages();
    const { data, error } = await sb.from('chat_messages')
      .insert({ thread_id: user.id, sender: 'customer', body, product_id: product ? product.id : null })
      .select('id,sender,body,product_id,created_at').single();
    if (error) {
      state.chat.messages = state.chat.messages.filter(m => m !== temp);
      renderMessages();
      input.value = body;
      toast('ส่งข้อความไม่สำเร็จ: ' + error.message, 'error');
      return;
    }
    const idx = state.chat.messages.indexOf(temp);
    if (idx >= 0) {
      if (state.chat.messages.some(m => m.id === data.id)) state.chat.messages.splice(idx, 1);
      else state.chat.messages[idx] = data;
      renderMessages();
    }
  });

  // ---------- Modals ----------
  function showModal(id) {
    $(id).hidden = false;
    document.body.classList.add('no-scroll');
  }
  function closeModal(id) {
    $(id).hidden = true;
    if (id === 'product-modal' && location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search);
    if (!document.querySelector('.modal:not([hidden]), .drawer:not([hidden])')) document.body.classList.remove('no-scroll');
  }

  // ---------- Global events ----------
  function bindGlobal() {
    document.addEventListener('click', e => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn) {
        const wrap = closeBtn.closest('.modal, .drawer');
        if (wrap) closeModal(wrap.id);
        return;
      }
      const card = e.target.closest('.product[data-id]');
      if (card) { openProduct(card.dataset.id); return; }
      const chip = e.target.closest('.cat-chip');
      if (chip) {
        state.category = chip.dataset.cat;
        renderCategories();
        renderGrid();
        $('products').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const open = document.querySelector('.modal:not([hidden]), .drawer:not([hidden])');
      if (open) closeModal(open.id);
      else if (state.chat.open) closeChat();
    });

    $('search-form').addEventListener('submit', e => { e.preventDefault(); state.query = $('search-input').value; renderGrid(); });
    $('search-input').addEventListener('input', e => { state.query = e.target.value; renderGrid(); });
    $('sort-select').addEventListener('change', e => { state.sort = e.target.value; renderGrid(); });
    $('cart-btn').addEventListener('click', openCart);
    $('orders-btn').addEventListener('click', openOrders);
    $('chat-fab').addEventListener('click', () => state.chat.open ? closeChat() : openChat());
    $('chat-close').addEventListener('click', closeChat);
    $('hero-chat-btn').addEventListener('click', () => openChat());
    $('success-chat-btn').addEventListener('click', () => { closeModal('success-modal'); openChat(); });
    window.addEventListener('hashchange', openFromHash);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.chat.loaded) loadMessages(); });
  }

  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; }
  }

  // ---------- Demo data (แสดงเมื่อยังไม่ได้ตั้งค่า DB) ----------
  const DEMO_PRODUCTS = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'ข้าวหอมมะลิ 100% ถุง 5 กก.', description: 'ข้าวหอมมะลิใหม่ต้นฤดู หอมนุ่ม', price: 189, compare_price: 220, category: 'ของกิน', image_url: 'https://picsum.photos/seed/rice5kg/600/600', stock: 40, sold_count: 12, created_at: '2026-01-05T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000002', name: 'ส้มโอขาวแตงกวา (ลูกใหญ่)', description: 'จากสวนในชัยนาท หวานฉ่ำ', price: 89, compare_price: 120, category: 'ผลไม้', image_url: 'https://picsum.photos/seed/pomelo/600/600', stock: 25, sold_count: 51, created_at: '2026-01-04T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000003', name: 'น้ำดื่ม แพ็ค 12 ขวด', description: 'ขวด 600 มล.', price: 55, compare_price: 65, category: 'ของกิน', image_url: 'https://picsum.photos/seed/water12/600/600', stock: 100, sold_count: 210, created_at: '2026-01-03T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000004', name: 'เสื้อยืดคอกลม สีขาว', description: 'คอตตอน 100% แจ้งไซส์ทางแชท', price: 159, compare_price: 199, category: 'เสื้อผ้า', image_url: 'https://picsum.photos/seed/tshirt/600/600', stock: 30, sold_count: 8, created_at: '2026-01-02T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000005', name: 'แก๊สหุงต้ม 15 กก. (เปลี่ยนถัง)', description: 'ส่งถึงบ้านในเขต อ.เมือง', price: 425, compare_price: null, category: 'ของใช้ในบ้าน', image_url: 'https://picsum.photos/seed/lpg15/600/600', stock: 15, sold_count: 77, created_at: '2026-01-01T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000006', name: 'หูฟังบลูทูธ ไร้สาย', description: 'แบตอึด 24 ชม. ประกัน 6 เดือน', price: 349, compare_price: 590, category: 'อิเล็กทรอนิกส์', image_url: 'https://picsum.photos/seed/earbuds/600/600', stock: 0, sold_count: 5, created_at: '2025-12-30T00:00:00Z' }
  ];

  init();
})();
