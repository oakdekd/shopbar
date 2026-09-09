// ส่วนที่ใช้ร่วมกันระหว่างหน้าร้านและหน้าแอดมิน
window.ShopCommon = (function () {
  const cfg = window.SHOPBAR_CONFIG || {};
  const shop = window.SHOP_CONFIG || {};

  const sb = window.supabase && cfg.SUPABASE_URL
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
        realtime: { params: { eventsPerSecond: 10 } }
      })
    : null;

  const PLACEHOLDER_IMG =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%23f3f4f6'/%3E%3Cpath d='M60 130l25-32 20 24 15-18 30 26H60z' fill='%23d1d5db'/%3E%3Ccircle cx='75' cy='72' r='12' fill='%23d1d5db'/%3E%3C/svg%3E";

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function money(n) {
    const v = Number(n) || 0;
    return '฿' + v.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const t = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return t;
    return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) + ' ' + t;
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString('th-TH', {
      day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function imgOf(p) {
    return (p && p.image_url) || PLACEHOLDER_IMG;
  }

  function discountPct(p) {
    if (!p.compare_price || Number(p.compare_price) <= Number(p.price)) return 0;
    return Math.round((1 - Number(p.price) / Number(p.compare_price)) * 100);
  }

  const STATUS = {
    new:       { label: 'รอยืนยัน',   cls: 'st-new' },
    confirmed: { label: 'ยืนยันแล้ว', cls: 'st-confirmed' },
    shipping:  { label: 'กำลังส่ง',   cls: 'st-shipping' },
    done:      { label: 'ส่งแล้ว',    cls: 'st-done' },
    cancelled: { label: 'ยกเลิก',     cls: 'st-cancelled' }
  };

  // toast แจ้งเตือนเล็ก ๆ
  let toastTimer = null;
  function toast(msg, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' toast-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  // ย่อรูปก่อนอัปโหลด (ประหยัดพื้นที่ + โหลดไว)
  function compressImage(file, maxSize, quality) {
    maxSize = maxSize || 1000;
    quality = quality || 0.85;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ')), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('อ่านไฟล์รูปไม่ได้')); };
      img.src = url;
    });
  }

  return { sb, cfg, shop, esc, money, fmtTime, fmtDate, imgOf, discountPct, STATUS, toast, compressImage, PLACEHOLDER_IMG };
})();
