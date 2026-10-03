import { createClient } from '@supabase/supabase-js';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;

  if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });

  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return json({ error: 'Server env vars not set (SUPABASE_URL / SUPABASE_SERVICE_KEY)' }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  let body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try { body = await request.json(); } catch (e) { body = {}; }
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
    const parts = path.split('/').filter(Boolean);
    const resource = parts[0] || '';
    const id = parts[1];

    const toWibStart = (d) => new Date(d + 'T00:00:00+07:00').toISOString();
    const toWibEnd = (d) => {
      const t = new Date(d + 'T00:00:00+07:00');
      t.setUTCDate(t.getUTCDate() + 1);
      return t.toISOString();
    };

    // ===== RESET DATA: 15 tabel + log =====
    if (resource === 'reset-data' && request.method === 'POST') {
      const performedBy = (body && body.device) ? String(body.device).slice(0, 80) : 'unknown';
      const results = {};
      const wipe = async (table, col) => {
        try {
          const { data: rows, error: selErr } = await supabase.from(table).select(col).limit(50000);
          if (selErr) { results[table] = selErr.message; return; }
          if (!rows || !rows.length) { results[table] = 'empty'; return; }
          const ids = rows.map(r => r[col]);
          const CHUNK = 500;
          for (let i = 0; i < ids.length; i += CHUNK) {
            const { error } = await supabase.from(table).delete().in(col, ids.slice(i, i + CHUNK));
            if (error) { results[table] = error.message; return; }
          }
          results[table] = 'ok';
        } catch (e) { results[table] = e.message; }
      };
      await wipe('order_items', 'id');
      await wipe('orders', 'id');
      await wipe('expenses', 'id');
      await wipe('holds', 'id');
      await wipe('profit_distribution_items', 'id');
      await wipe('profit_distributions', 'id');
      await wipe('stock_transactions', 'id');
      await wipe('journal_entries', 'id');
      await wipe('cash_transactions', 'id');
      await wipe('kas_closures', 'id');
      await wipe('stock_buys', 'id');
      await wipe('stock_opname', 'id');
      await wipe('waste', 'id');
      await wipe('payables', 'id');
      await wipe('receivables', 'id');
      await supabase.from('settings').update({ last_reset_at: new Date().toISOString() }).eq('id', 1);
      try { await supabase.from('audit_log').insert({ action: 'reset-data', performed_by: performedBy, created_at: new Date().toISOString() }); } catch (e) {}
      return json({ success: true, results });
    }

    // ===== IMPORT DATA =====
    if (resource === 'import-data' && request.method === 'POST') {
      const orders = body.orders || [];
      const expenses = body.expenses || [];
      const cash = body.cash || [];
      const results = { orders: 0, expenses: 0, skippedOrders: 0 };
      for (const o of orders) {
        try {
          const { data: dup } = await supabase.from('orders').select('id').eq('order_number', o.order_number).maybeSingle();
          if (dup) { results.skippedOrders++; continue; }
          const its = o.items || [];
          const payload = Object.assign({}, o); delete payload.items;
          const { data: no, error: oe } = await supabase.from('orders').insert(payload).select().single();
          if (oe) continue;
          results.orders++;
          if (its.length) {
            await supabase.from('order_items').insert(its.map(x => Object.assign({}, x, { order_id: no.id })));
          }
        } catch (e) { /* lanjut */ }
      }
      if (expenses.length) {
        const { error } = await supabase.from('expenses').insert(expenses);
        if (!error) results.expenses = expenses.length;
      }
      for (const c of cash) {
        try { await supabase.from('cash_transactions').insert(c); } catch (e) { /* skip */ }
      }
      return json({ success: true, results });
    }

    // ===== SETTINGS =====
    if (resource === 'settings') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'PUT') {
        const { data, error } = await supabase.from('settings').update({ ...body, updated_at: new Date().toISOString() }).eq('id', 1).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
    }

    // ===== MENU =====
    if (resource === 'menu' && request.method === 'GET') {
      const [cats, items, vars, ads, ia] = await Promise.all([
        supabase.from('categories').select('*').order('sort_order'),
        supabase.from('menu_items').select('*').order('sort_order'),
        supabase.from('menu_variants').select('*').order('sort_order'),
        supabase.from('addons').select('*').eq('is_active', true),
        supabase.from('menu_item_addons').select('*'),
      ]);
      return json({ c: cats.data || [], i: items.data || [], v: vars.data || [], a: ads.data || [], ia: ia.data || [] });
    }

    // ===== CATEGORIES =====
    if (resource === 'categories') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('categories').select('*').order('sort_order');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.name) return json({ error: 'name is required' }, 400);
        const { data, error } = await supabase.from('categories').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('categories').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { data: itemsInCat } = await supabase.from('menu_items').select('id').eq('category_id', id);
        const itemIds = (itemsInCat || []).map(i => i.id);
        if (itemIds.length) {
          await supabase.from('menu_variants').delete().in('menu_item_id', itemIds);
          await supabase.from('menu_item_addons').delete().in('menu_item_id', itemIds);
          await supabase.from('recipes').delete().in('menu_item_id', itemIds);
          await supabase.from('menu_items').delete().in('id', itemIds);
        }
        const { error } = await supabase.from('categories').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== MENU ITEM =====
    if (resource === 'menu-item') {
      if (request.method === 'POST') {
        if (!body.name || body.base_price == null) return json({ error: 'name and base_price are required' }, 400);
        const { data, error } = await supabase.from('menu_items').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('menu_items').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        await supabase.from('menu_variants').delete().eq('menu_item_id', id);
        await supabase.from('menu_item_addons').delete().eq('menu_item_id', id);
        await supabase.from('recipes').delete().eq('menu_item_id', id);
        const { error } = await supabase.from('menu_items').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== PLACE ORDER =====
    if (resource === 'order' && request.method === 'POST') {
      const { order, items, table_id } = body;
      if (!order || !items || !Array.isArray(items) || items.length === 0) {
        return json({ error: 'order and a non-empty items array are required' }, 400);
      }
      if (order.created_at) {
        let dupQuery = supabase.from('orders').select('*, order_items(*)').eq('created_at', order.created_at);
        if (order.total != null) dupQuery = dupQuery.eq('total', order.total);
        const { data: existing } = await dupQuery.maybeSingle();
        if (existing) {
          return json({ order: existing, order_number: existing.order_number, duplicate: true });
        }
      }
      let newOrder = null;
      let orderErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data: lastOrder } = await supabase.from('orders').select('order_number').order('id', { ascending: false }).limit(1).maybeSingle();
        let orderNum = 'MS00001';
        if (lastOrder?.order_number) {
          const num = parseInt(lastOrder.order_number.replace(/\D/g, '')) + 1 + attempt;
          orderNum = 'MS' + String(num).padStart(5, '0');
        } else if (attempt > 0) {
          orderNum = 'MS' + String(attempt + 1).padStart(5, '0');
        }
        const result = await supabase.from('orders').insert({ ...order, order_number: orderNum }).select().single();
        if (!result.error) {
          newOrder = result.data;
          orderErr = null;
          break;
        }
        orderErr = result.error;
        if (result.error.code === '23505' && order.created_at) {
          const { data: existing } = await supabase.from('orders').select('*, order_items(*)').eq('created_at', order.created_at).maybeSingle();
          if (existing) {
            return json({ order: existing, order_number: existing.order_number, duplicate: true });
          }
        }
        if (result.error.code !== '23505') break;
      }
      if (orderErr) return json({ error: orderErr.message }, 500);
      if (!newOrder) return json({ error: 'Could not allocate a unique order number, please retry' }, 500);

      const orderItems = items.map(it => ({ ...it, order_id: newOrder.id }));
      const { error: itemsErr } = await supabase.from('order_items').insert(orderItems);
      if (itemsErr) return json({ error: itemsErr.message }, 500);

      if (table_id) {
        await supabase.from('tables').update({ status: 'available', hold_order: null, updated_at: new Date().toISOString() }).eq('id', table_id);
      }

      for (const item of items) {
        if (!item.menu_item_id) continue;
        const { data: recipes } = await supabase.from('recipes').select('ingredient_id, quantity').eq('menu_item_id', item.menu_item_id);
        if (recipes && recipes.length > 0) {
          for (const r of recipes) {
            const reduceQty = parseFloat(r.quantity) * item.quantity;
            const { data: ing } = await supabase.from('ingredients').select('stock').eq('id', r.ingredient_id).single();
            if (ing) {
              await supabase.from('ingredients').update({ stock: parseFloat(ing.stock) - reduceQty }).eq('id', r.ingredient_id);
              await supabase.from('stock_transactions').insert({ ingredient_id: r.ingredient_id, quantity: -reduceQty, type: 'out', note: `Order ${newOrder.order_number}` });
            }
          }
        }
      }
      return json({ order: newOrder, order_number: newOrder.order_number });
    }

    // ===== TRANSACTIONS =====
    if (resource === 'transactions' && request.method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let query = supabase.from('orders').select('*, order_items(*)').order('created_at', { ascending: false });
      if (from) query = query.gte('created_at', toWibStart(from));
      if (to) query = query.lte('created_at', toWibEnd(to));
      const { data, error } = await query.limit(500);
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }
    if (resource === 'transactions' && request.method === 'PUT' && id) {
      const allowed = {};
      if (body.status !== undefined) allowed.status = body.status;
      if (Object.keys(allowed).length === 0) return json({ error: 'no updatable fields sent' }, 400);
      const { data, error } = await supabase.from('orders').update(allowed).eq('id', id).select();
      if (error) return json({ error: error.message }, 500);
      return json(data[0] || { success: true });
    }
    if (resource === 'transactions' && request.method === 'DELETE' && id) {
      const { data: oItems } = await supabase.from('order_items').select('*').eq('order_id', id);
      for (const item of (oItems || [])) {
        if (!item.menu_item_id) continue;
        const { data: recipes } = await supabase.from('recipes').select('ingredient_id, quantity').eq('menu_item_id', item.menu_item_id);
        for (const r of (recipes || [])) {
          const { data: ing } = await supabase.from('ingredients').select('stock').eq('id', r.ingredient_id).single();
          if (ing) {
            await supabase.from('ingredients').update({ stock: parseFloat(ing.stock) + parseFloat(r.quantity) * item.quantity }).eq('id', r.ingredient_id);
          }
        }
      }
      await supabase.from('order_items').delete().eq('order_id', id);
      const { error } = await supabase.from('orders').delete().eq('id', id);
      if (error) return json({ error: error.message }, 500);
      return json({ success: true });
    }

    if (resource === 'dashboard' && request.method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      let query = supabase.from('orders').select('id, total, order_type, created_at');
      if (from) query = query.gte('created_at', toWibStart(from));
      if (to) query = query.lte('created_at', toWibEnd(to));
      const { data: orders, error } = await query;
      if (error) return json({ error: error.message }, 500);

      const totalSales = orders.reduce((s, o) => s + parseFloat(o.total || 0), 0);
      return json({
        totalSales, totalOrders: orders.length,
        dineInCount: orders.filter(o => o.order_type === 'dine-in').length,
        takeawayCount: orders.filter(o => o.order_type === 'takeaway').length
      });
    }

    // ===== INGREDIENTS =====
    if (resource === 'ingredients') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('ingredients').select('*').order('name');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.name) return json({ error: 'name is required' }, 400);
        const { data, error } = await supabase.from('ingredients').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('ingredients').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        await supabase.from('recipes').delete().eq('ingredient_id', id);
        const { error } = await supabase.from('ingredients').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }
    if (resource === 'recipes') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('recipes').select('*, ingredients(*)').order('id');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.menu_item_id || !body.ingredient_id || body.quantity == null) {
          return json({ error: 'menu_item_id, ingredient_id and quantity are required' }, 400);
        }
        const { data, error } = await supabase.from('recipes').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('recipes').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('recipes').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }
    if (resource === 'stock-in' && request.method === 'POST') {
      const { ingredient_id, quantity, note } = body;
      if (!ingredient_id || !quantity) return json({ error: 'ingredient_id and quantity are required' }, 400);
      const { data: ing } = await supabase.from('ingredients').select('stock').eq('id', ingredient_id).single();
      if (!ing) return json({ error: 'Bahan tidak ditemukan di server (belum tersinkron?)' }, 404);
      await supabase.from('ingredients').update({ stock: parseFloat(ing.stock) + parseFloat(quantity) }).eq('id', ingredient_id);
      await supabase.from('stock_transactions').insert({ ingredient_id, quantity: parseFloat(quantity), type: 'in', note: note || 'Stock in' });
      return json({ success: true });
    }

    // ===== EMPLOYEES =====
    if (resource === 'employees') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('employees').select('*').eq('is_active', true).order('name');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.name || !body.pin) return json({ error: 'name and pin are required' }, 400);
        const { data, error } = await supabase.from('employees').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('employees').update({ is_active: false }).eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== ATTENDANCE =====
    if (resource === 'attendance') {
      if (request.method === 'GET') {
        const date = url.searchParams.get('date');
        let q = supabase.from('attendance').select('*').order('clock_in', { ascending: false });
        if (date) q = q.eq('date', date);
        const { data, error } = await q.limit(200);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.emp_id || !body.name || !body.date || !body.clock_in) {
          return json({ error: 'emp_id, name, date and clock_in are required' }, 400);
        }
        const { data, error } = await supabase.from('attendance').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('attendance').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
    }

    // ===== HOLDS =====
    if (resource === 'holds') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('holds').select('*').order('created_at', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.order_number || !body.cart) return json({ error: 'order_number and cart are required' }, 400);
        const { data, error } = await supabase.from('holds').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('holds').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== ACCOUNTS =====
    if (resource === 'accounts') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('accounts').select('*').eq('is_active', true).order('sort_order');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.name || !body.group_label) return json({ error: 'name and group_label are required' }, 400);
        const { data, error } = await supabase.from('accounts').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('accounts').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('accounts').update({ is_active: false }).eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== INVESTORS =====
    if (resource === 'investors') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('investors').select('*').order('id');
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.name || body.percentage == null) return json({ error: 'name and percentage are required' }, 400);
        const { data, error } = await supabase.from('investors').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('investors').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('investors').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== PROFIT DISTRIBUTIONS =====
    if (resource === 'profit-distributions') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('profit_distributions').select('*, profit_distribution_items(*)').order('created_at', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        const { items, ...dist } = body;
        if (!dist.period_label || dist.net_profit == null || !Array.isArray(items)) {
          return json({ error: 'period_label, net_profit and items[] are required' }, 400);
        }
        const { data: newDist, error: distErr } = await supabase.from('profit_distributions').insert(dist).select().single();
        if (distErr) return json({ error: distErr.message }, 500);
        const rows = items.map(it => ({ ...it, distribution_id: newDist.id }));
        const { error: itemsErr } = await supabase.from('profit_distribution_items').insert(rows);
        if (itemsErr) return json({ error: itemsErr.message }, 500);
        return json(newDist);
      }
      if (request.method === 'DELETE' && id) {
        await supabase.from('profit_distribution_items').delete().eq('distribution_id', id);
        const { error } = await supabase.from('profit_distributions').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== EXPENSES =====
    if (resource === 'expenses') {
      if (request.method === 'GET') {
        const { data, error } = await supabase.from('expenses').select('*, accounts(name, group_label, type)').order('date', { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        if (!body.date || body.amount == null) return json({ error: 'date and amount are required' }, 400);
        const { data, error } = await supabase.from('expenses').insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from('expenses').update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from('expenses').delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    // ===== KAS SYNC: 8 resource generic CRUD + PROFIT SHARES =====
    const SYNC_TABLES = {
      'cash-transactions': 'cash_transactions',
      'kas-closures': 'kas_closures',
      'assets': 'assets',
      'stock-buys': 'stock_buys',
      'stock-opname': 'stock_opname',
      'waste': 'waste',
      'payables': 'payables',
      'receivables': 'receivables',
      'profit-shares': 'profit_shares'
    };
    if (SYNC_TABLES[resource]) {
      const table = SYNC_TABLES[resource];
      if (request.method === 'GET') {
        const orderCol = table === 'cash_transactions' ? 'ts' : 'id';
        const { data, error } = await supabase.from(table).select('*').order(orderCol, { ascending: false }).limit(2000);
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
      if (request.method === 'POST') {
        const { data, error } = await supabase.from(table).insert(body).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0]);
      }
      if (request.method === 'PUT' && id) {
        const { data, error } = await supabase.from(table).update(body).eq('id', id).select();
        if (error) return json({ error: error.message }, 500);
        return json(data[0] || { success: true });
      }
      if (request.method === 'DELETE' && id) {
        const { error } = await supabase.from(table).delete().eq('id', id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }
    }

    return json({ error: `Endpoint not found: ${request.method} /${path}` }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
