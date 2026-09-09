-- =====================================================================
--  ShopBar Market — โครงสร้างฐานข้อมูล (รันใน Supabase > SQL Editor)
--  รันได้ซ้ำ ๆ ปลอดภัย (idempotent)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) แอดมินร้าน  (ใส่ user_id ของบัญชีเจ้าของร้านลงตารางนี้)
-- ---------------------------------------------------------------------
create table if not exists public.shop_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_shop_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.shop_admins where user_id = auth.uid());
$$;

grant execute on function public.is_shop_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) สินค้า
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text not null default '',
  price         numeric(10,2) not null check (price >= 0),
  compare_price numeric(10,2) check (compare_price is null or compare_price >= 0),
  category      text not null default 'ทั่วไป',
  image_url     text,
  images        jsonb not null default '[]'::jsonb,
  stock         integer not null default 0 check (stock >= 0),
  sold_count    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists products_active_idx on public.products (is_active, created_at desc);

-- ---------------------------------------------------------------------
-- 3) แชท  (1 ลูกค้า = 1 ห้องแชท, id ห้อง = auth.uid() ของลูกค้า)
-- ---------------------------------------------------------------------
create table if not exists public.chat_threads (
  id              uuid primary key,
  customer_name   text,
  last_message    text,
  last_sender     text,
  unread_shop     integer not null default 0,
  unread_customer integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  thread_id  uuid not null references public.chat_threads(id) on delete cascade,
  sender     text not null check (sender in ('customer','shop')),
  body       text not null check (length(body) between 1 and 2000),
  product_id uuid references public.products(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, id);

-- ---------------------------------------------------------------------
-- 4) คำสั่งซื้อ
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id            bigint generated always as identity primary key,
  thread_id     uuid not null,
  customer_name text not null,
  phone         text not null,
  district      text not null,
  address       text not null,
  note          text,
  payment       text not null default 'cod' check (payment in ('cod','transfer')),
  items         jsonb not null,
  subtotal      numeric(10,2) not null default 0,
  delivery_fee  numeric(10,2) not null default 0,
  total         numeric(10,2) not null default 0,
  status        text not null default 'new'
                check (status in ('new','confirmed','shipping','done','cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists orders_thread_idx on public.orders (thread_id, created_at desc);
create index if not exists orders_status_idx on public.orders (status, created_at desc);

-- ---------------------------------------------------------------------
-- 5) Triggers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- เมื่อมีข้อความใหม่ -> อัปเดตสรุปห้องแชท + นับยังไม่อ่าน
create or replace function public.chat_message_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.chat_threads
     set last_message    = left(new.body, 200),
         last_sender     = new.sender,
         updated_at      = now(),
         unread_shop     = case when new.sender = 'customer' then unread_shop + 1 else unread_shop end,
         unread_customer = case when new.sender = 'shop'     then unread_customer + 1 else unread_customer end
   where id = new.thread_id;
  return new;
end $$;

drop trigger if exists chat_message_after_insert on public.chat_messages;
create trigger chat_message_after_insert after insert on public.chat_messages
  for each row execute function public.chat_message_after_insert();

-- เมื่อสั่งซื้อ -> ตรวจราคาจริงจากตารางสินค้า, คำนวณยอด, ตัดสต๊อก, ส่งข้อความเข้าแชท
create or replace function public.order_before_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  item      jsonb;
  prod      public.products%rowtype;
  qty       integer;
  new_items jsonb := '[]'::jsonb;
  sub       numeric(10,2) := 0;
  summary   text := '';
begin
  if new.items is null or jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    raise exception 'ตะกร้าว่าง';
  end if;

  for item in select * from jsonb_array_elements(new.items) loop
    qty := greatest(coalesce((item->>'qty')::integer, 1), 1);
    select * into prod from public.products where id = (item->>'id')::uuid and is_active;
    if not found then
      raise exception 'ไม่พบสินค้า %', item->>'name';
    end if;
    if prod.stock < qty then
      raise exception 'สินค้า "%" เหลือ % ชิ้น', prod.name, prod.stock;
    end if;

    update public.products
       set stock = stock - qty, sold_count = sold_count + qty
     where id = prod.id;

    new_items := new_items || jsonb_build_object(
      'id', prod.id, 'name', prod.name, 'price', prod.price, 'qty', qty, 'image_url', prod.image_url);
    sub := sub + prod.price * qty;
    summary := summary || format(E'\n• %s × %s = ฿%s', prod.name, qty, to_char(prod.price * qty, 'FM999,999,990.##'));
  end loop;

  new.items    := new_items;
  new.subtotal := sub;
  new.total    := sub + coalesce(new.delivery_fee, 0);
  new.status   := 'new';
  return new;
end $$;

drop trigger if exists order_before_insert on public.orders;
create trigger order_before_insert before insert on public.orders
  for each row execute function public.order_before_insert();

create or replace function public.order_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  item    jsonb;
  summary text := '';
begin
  insert into public.chat_threads (id, customer_name)
  values (new.thread_id, new.customer_name)
  on conflict (id) do update set customer_name = coalesce(public.chat_threads.customer_name, excluded.customer_name);

  for item in select * from jsonb_array_elements(new.items) loop
    summary := summary || format(E'\n• %s × %s', item->>'name', item->>'qty');
  end loop;

  insert into public.chat_messages (thread_id, sender, body)
  values (new.thread_id, 'customer',
    format(E'🧾 สั่งซื้อ #%s%s\nค่าส่ง ฿%s  รวม ฿%s\nจัดส่ง: %s\nชำระ: %s',
      new.id, summary,
      to_char(new.delivery_fee, 'FM999,990'),
      to_char(new.total, 'FM999,999,990.##'),
      new.district,
      case when new.payment = 'cod' then 'เงินสดปลายทาง' else 'โอนเงิน' end));
  return new;
end $$;

drop trigger if exists order_after_insert on public.orders;
create trigger order_after_insert after insert on public.orders
  for each row execute function public.order_after_insert();

-- เมื่อแอดมินเปลี่ยนสถานะ -> แจ้งลูกค้าในแชท
create or replace function public.order_status_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  label text;
begin
  if new.status is distinct from old.status then
    label := case new.status
      when 'confirmed' then '✅ ยืนยันคำสั่งซื้อแล้ว กำลังเตรียมสินค้า'
      when 'shipping'  then '🚚 กำลังนำสินค้าไปส่ง'
      when 'done'      then '🎉 จัดส่งเรียบร้อยแล้ว ขอบคุณที่อุดหนุนครับ'
      when 'cancelled' then '❌ คำสั่งซื้อถูกยกเลิก'
      else null end;
    if label is not null then
      insert into public.chat_messages (thread_id, sender, body)
      values (new.thread_id, 'shop', format('คำสั่งซื้อ #%s: %s', new.id, label));
    end if;
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      -- คืนสต๊อก
      update public.products p
         set stock = p.stock + (i->>'qty')::integer,
             sold_count = greatest(p.sold_count - (i->>'qty')::integer, 0)
        from jsonb_array_elements(new.items) i
       where p.id = (i->>'id')::uuid;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists order_status_notify on public.orders;
create trigger order_status_notify after update on public.orders
  for each row execute function public.order_status_notify();

-- ---------------------------------------------------------------------
-- 6) Row Level Security
-- ---------------------------------------------------------------------
alter table public.shop_admins   enable row level security;
alter table public.products      enable row level security;
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;
alter table public.orders        enable row level security;

-- shop_admins: อ่านได้เฉพาะตัวเอง
drop policy if exists "admins self read" on public.shop_admins;
create policy "admins self read" on public.shop_admins
  for select to authenticated using (user_id = auth.uid());

-- products: ทุกคนเห็นสินค้าที่เปิดขาย, แอดมินจัดการได้ทั้งหมด
drop policy if exists "products public read" on public.products;
create policy "products public read" on public.products
  for select to anon, authenticated using (is_active or public.is_shop_admin());

drop policy if exists "products admin write" on public.products;
create policy "products admin write" on public.products
  for all to authenticated using (public.is_shop_admin()) with check (public.is_shop_admin());

-- chat_threads: ลูกค้าเห็น/สร้าง/แก้ห้องของตัวเอง, แอดมินทั้งหมด
drop policy if exists "threads own or admin" on public.chat_threads;
create policy "threads own or admin" on public.chat_threads
  for select to authenticated using (id = auth.uid() or public.is_shop_admin());

drop policy if exists "threads own insert" on public.chat_threads;
create policy "threads own insert" on public.chat_threads
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "threads own or admin update" on public.chat_threads;
create policy "threads own or admin update" on public.chat_threads
  for update to authenticated
  using (id = auth.uid() or public.is_shop_admin())
  with check (id = auth.uid() or public.is_shop_admin());

-- chat_messages
drop policy if exists "messages own or admin read" on public.chat_messages;
create policy "messages own or admin read" on public.chat_messages
  for select to authenticated using (thread_id = auth.uid() or public.is_shop_admin());

drop policy if exists "messages customer insert" on public.chat_messages;
create policy "messages customer insert" on public.chat_messages
  for insert to authenticated
  with check (
    (thread_id = auth.uid() and sender = 'customer')
    or (public.is_shop_admin() and sender = 'shop')
  );

-- orders
drop policy if exists "orders own or admin read" on public.orders;
create policy "orders own or admin read" on public.orders
  for select to authenticated using (thread_id = auth.uid() or public.is_shop_admin());

drop policy if exists "orders own insert" on public.orders;
create policy "orders own insert" on public.orders
  for insert to authenticated with check (thread_id = auth.uid());

drop policy if exists "orders admin update" on public.orders;
create policy "orders admin update" on public.orders
  for update to authenticated using (public.is_shop_admin()) with check (public.is_shop_admin());

-- ---------------------------------------------------------------------
-- 7) Realtime
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_threads') then
    alter publication supabase_realtime add table public.chat_threads;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'products') then
    alter publication supabase_realtime add table public.products;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8) Storage: รูปสินค้า (bucket สาธารณะ อ่านได้ทุกคน, แอดมินอัปโหลด)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = true;

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'product-images');

drop policy if exists "product images admin insert" on storage.objects;
create policy "product images admin insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'product-images' and public.is_shop_admin());

drop policy if exists "product images admin update" on storage.objects;
create policy "product images admin update" on storage.objects
  for update to authenticated using (bucket_id = 'product-images' and public.is_shop_admin());

drop policy if exists "product images admin delete" on storage.objects;
create policy "product images admin delete" on storage.objects
  for delete to authenticated using (bucket_id = 'product-images' and public.is_shop_admin());

-- =====================================================================
--  ขั้นตอนหลังรัน SQL นี้:
--  1. Authentication > Providers > เปิด "Anonymous sign-ins"  (ลูกค้าใช้แชท/สั่งซื้อโดยไม่ต้องสมัคร)
--  2. Authentication > Users > Add user  สร้างบัญชีแอดมิน (อีเมล + รหัสผ่าน, ติ๊ก Auto Confirm)
--  3. รันคำสั่งนี้เพื่อตั้งเป็นแอดมิน (แก้อีเมลให้ตรง):
--       insert into public.shop_admins (user_id)
--       select id from auth.users where email = 'you@example.com'
--       on conflict do nothing;
-- =====================================================================
