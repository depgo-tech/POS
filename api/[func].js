const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase URL atau Key belum diset di Vercel Environment Variables!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

function hashPassword(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { func } = req.query;
  const body = req.body || {};

  try {
    if (func === 'getPengaturan') {
      const { data } = await supabase.from('pengaturan').select('*').eq('id', 1).single();
      if (data) return res.json([data.nama_toko, data.alamat, data.telp, data.footer, data.logo_toko, data.logo_struk]);
      return res.json(['Benk cell', '', '', 'Terima kasih telah berbelanja!', '', '']);
    }

    if (func === 'getUsernamesForLogin') {
      const { data } = await supabase.from('users').select('username, full_name');
      return res.json(data || []);
    }

    if (func === 'login') {
      const { username, password } = body;
      const hashed = hashPassword(password || '');
      const { data: user } = await supabase.from('users').select('*').ilike('username', String(username || '').trim()).single();
      if (user) {
        const storedPass = String(user.password);
        const match = (storedPass.length === 64 && storedPass === hashed) || (storedPass === password);
        if (match) return res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role });
      }
      return res.json(null);
    }

    if (func === 'getProduk') {
      const { data } = await supabase.from('produk').select('*').order('nama', { ascending: true });
      const mapped = (data || []).map(p => [p.id, p.nama, p.varian, p.storage, p.harga, p.stok, p.kategori, p.foto, p.imeis || [], p.is_konsinyasi || false, p.mitra_id || null, p.harga_setoran || 0]);
      return res.json(mapped);
    }

    if (func === 'saveProduk') {
      const data = body;
      if (!data.nama || data.harga === '' || data.harga === undefined) return res.status(400).json({ error: 'Nama dan Harga wajib diisi.' });
      
      let imeis = [];
      if (data.imeiText) {
        imeis = String(data.imeiText).split('\n').map(s => s.trim()).filter(Boolean).map(i => ({ imei: i, status: 'tersedia' }));
      }
      
      const payload = {
        id: data.id, nama: data.nama, varian: data.varian, storage: data.storage, 
        harga: Number(data.harga), stok: imeis.length > 0 ? imeis.length : (Number(data.stok) || 0), 
        kategori: data.kategori, foto: data.foto, imeis: imeis,
        is_konsinyasi: data.isKonsinyasi || false,
        mitra_id: data.isKonsinyasi ? data.mitraId : null,
        harga_setoran: data.isKonsinyasi ? (Number(data.hargaSetoran) || 0) : 0
      };
      
      const { data: existing } = await supabase.from('produk').select('id').eq('id', data.id).single();
      if (existing) {
        await supabase.from('produk').update(payload).eq('id', data.id);
      } else {
        await supabase.from('produk').insert([payload]);
      }
      return res.json("Sukses");
    }

    if (func === 'simpanTransaksi') {
      const { keranjang, pelanggan, diskonStr, metode, ttNama, ttImei, ttNilai, masaGaransi } = body;
      
      // Validasi Stok & IMEI
      for (let item of keranjang) {
        const { data: prod } = await supabase.from('produk').select('*').eq('id', item.id).single();
        if (!prod) return res.status(400).json({ error: 'Produk tidak ditemukan di database.' });
        if (item.imei) {
          let imeiExists = (prod.imeis || []).some(im => im.imei === item.imei && im.status === 'tersedia');
          if (!imeiExists) return res.status(400).json({ error: 'IMEI ' + item.imei + ' tidak tersedia untuk produk ' + prod.nama });
        } else {
          if (Number(item.qty) > Number(prod.stok)) return res.status(400).json({ error: 'Stok "' + prod.nama + '" tidak cukup.' });
        }
      }

      // Hitung Total
      let total = 0;
      let itemsArr = [];
      keranjang.forEach(item => {
        total += Number(item.harga) * Number(item.qty);
        let storageTxt = item.storage ? ' (' + item.storage + ')' : '';
        let imeiTxt = item.imei ? ' [IMEI:' + item.imei + ']' : '';
        itemsArr.push(item.nama + ' ' + item.varian + storageTxt + imeiTxt + ' x' + item.qty);
      });

      let diskonRp = 0;
      if (String(diskonStr).indexOf('%') !== -1) diskonRp = (total * parseFloat(diskonStr)) / 100;
      else diskonRp = parseFloat(diskonStr) || 0;

      let nilaiTukar = Number(ttNilai) || 0;
      let totalAkhir = total - diskonRp - nilaiTukar;
      let tgl = new Date().toISOString();
      let idTrx = 'INV' + tgl.replace(/[-:T]/g, '').split('.')[0];

      await supabase.from('transaksi').insert([{
        id: idTrx, tgl: tgl, pelanggan: pelanggan, items: itemsArr.join(', '), 
        total: totalAkhir, metode: metode, diskon: diskonStr,
        tt_nama: ttNama || null, tt_imei: ttImei || null, tt_nilai: nilaiTukar
      }]);

      // Update Stok, IMEI, Garansi, & Hutang Konsinyasi
      for (let item of keranjang) {
        const { data: prod } = await supabase.from('produk').select('*').eq('id', item.id).single();
        if (item.imei) {
          let newImeis = (prod.imeis || []).filter(im => im.imei !== item.imei);
          await supabase.from('produk').update({ imeis: newImeis, stok: newImeis.length }).eq('id', item.id);
          
          // Masukkan ke tabel Garansi dengan masa garansi dari input kasir
          await supabase.from('garansi').insert([{
            id: 'GR' + Date.now() + Math.floor(Math.random() * 1000),
            no_invoice: idTrx, tgl: tgl, imei: item.imei,
            nama_produk: item.nama + ' ' + item.varian, pelanggan: pelanggan,
            telp: '', masa_garansi: Number(masaGaransi) || 0
          }]);
        } else {
          let newStok = Number(prod.stok) - Number(item.qty);
          await supabase.from('produk').update({ stok: newStok }).eq('id', item.id);
        }

        // Jika produk konsinyasi, tambahkan hutang ke mitra
        if (prod.is_konsinyasi && prod.mitra_id) {
          let tambahanHutang = Number(prod.harga_setoran || 0) * Number(item.qty);
          const { data: mitra } = await supabase.from('mitra').select('hutang').eq('id', prod.mitra_id).single();
          if (mitra) {
            await supabase.from('mitra').update({ hutang: Number(mitra.hutang) + tambahanHutang }).eq('id', prod.mitra_id);
          }
        }
      }

      return res.json({ status: "Sukses", idTrx: idTrx, total: totalAkhir });
    }

    if (func === 'getGaransi') {
      const { data } = await supabase.from('garansi').select('*').order('tgl', { ascending: false });
      const mapped = (data || []).map(g => {
        let tglObj = new Date(g.tgl);
        let expDate = new Date(tglObj);
        expDate.setMonth(expDate.getMonth() + (g.masa_garansi || 0));
        return { id: g.id, invoice: g.no_invoice, tgl: g.tgl, imei: g.imei, produk: g.nama_produk, pelanggan: g.pelanggan, telp: g.telp, exp: expDate.toISOString(), masaGaransi: g.masa_garansi };
      });
      return res.json(mapped);
    }

    // --- FITUR KONSINYASI (MITRA) ---
    if (func === 'getMitra') {
      const { data } = await supabase.from('mitra').select('*').order('nama', { ascending: true });
      return res.json(data || []);
    }

    if (func === 'addMitra') {
      const { nama, telp } = body;
      if (!nama) return res.status(400).json({ error: "Nama mitra wajib diisi!" });
      let id = 'MTR' + Date.now();
      await supabase.from('mitra').insert([{ id: id, nama: nama, telp: telp || '', hutang: 0 }]);
      return res.json("Sukses");
    }

    if (func === 'bayarHutangMitra') {
      const { id, jumlah } = body;
      const { data: mitra } = await supabase.from('mitra').select('hutang').eq('id', id).single();
      if (mitra) {
        let newHutang = Number(mitra.hutang) - Number(jumlah);
        if (newHutang < 0) newHutang = 0;
        await supabase.from('mitra').update({ hutang: newHutang }).eq('id', id);
        return res.json("Sukses");
      }
      return res.status(400).json({ error: "Mitra tidak ditemukan" });
    }

    // --- FUNGSI LAMA ---
    if (func === 'getRiwayatTransaksi') {
      const { startDate, endDate } = body;
      let now = new Date();
      let todayStr = now.toISOString().split('T')[0];
      let start = (startDate || todayStr) + "T00:00:00.000Z";
      let end = (endDate || startDate || todayStr) + "T23:59:59.999Z";
      const { data } = await supabase.from('transaksi').select('*').gte('tgl', start).lte('tgl', end).order('tgl', { ascending: false });
      const mapped = (data || []).map(row => ({ id: row.id, tgl: row.tgl, pelanggan: row.pelanggan, items: row.items ? row.items.split(', ') : [], total: row.total, metode: row.metode }));
      return res.json(mapped);
    }

    if (func === 'getDashboardData') {
      const { startDate, endDate } = body;
      let now = new Date();
      let todayStr = now.toISOString().split('T')[0];
      let start = (startDate || todayStr) + "T00:00:00.000Z";
      let end = (endDate || startDate || todayStr) + "T23:59:59.999Z";
      const { data: trxData } = await supabase.from('transaksi').select('*');
      const { data: prodData } = await supabase.from('produk').select('*');
      let penjualanPeriode = 0, trxPeriode = 0, totalStok = 0, lowStok = [];
      let chartLabels = [], chartData = [], chartDateMap = {};
      for (let i = 6; i >= 0; i--) {
        let d = new Date(); d.setDate(d.getDate() - i);
        let key = d.toISOString().split('T')[0];
        chartLabels.push(d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' }));
        chartData.push(0); chartDateMap[key] = chartLabels.length - 1;
      }
      (trxData || []).forEach(row => {
        let tglObj = new Date(row.tgl);
        let nilai = Number(row.total) || 0;
        let tglStr = tglObj.toISOString().split('T')[0];
        if (tglObj >= new Date(start) && tglObj <= new Date(end)) { penjualanPeriode += nilai; trxPeriode++; }
        if (chartDateMap.hasOwnProperty(tglStr)) chartData[chartDateMap[tglStr]] += nilai;
      });
      (prodData || []).forEach(p => {
        let stok = p.imeis ? p.imeis.length : Number(p.stok);
        totalStok += stok;
        if (stok <= 5) lowStok.push({ id: p.id, nama: p.nama, varian: p.varian, stok: stok });
      });
      return res.json({ penjualanPeriode, trxPeriode, totalTrx: trxData ? trxData.length : 0, totalProduk: prodData ? prodData.length : 0, totalStok, lowStok, chartLabels, chartData });
    }

    if (func === 'getUsers') {
      const { data } = await supabase.from('users').select('*');
      const mapped = (data || []).map(u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role }));
      return res.json(mapped);
    }

    if (func === 'addUser') {
      const { u, p, n, r } = body;
      if (!u || !p || !n) return res.status(400).json({ error: "Semua kolom wajib diisi!" });
      const { data: exist } = await supabase.from('users').select('id').ilike('username', u).single();
      if (exist) return res.status(400).json({ error: "Username sudah dipakai!" });
      let id = 'USR' + Date.now();
      await supabase.from('users').insert([{ id: id, username: u, password: hashPassword(p), full_name: n, role: r }]);
      return res.json("Sukses");
    }

    if (func === 'resetUserPassword') {
      const { id, newPassword } = body;
      await supabase.from('users').update({ password: hashPassword(newPassword) }).eq('id', id);
      return res.json("Sukses");
    }

    if (func === 'deleteProduk') {
      const { id } = body;
      await supabase.from('produk').delete().eq('id', id);
      return res.json("Sukses");
    }

    if (func === 'deleteUser') {
      const { id } = body;
      const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
      const { data: target } = await supabase.from('users').select('role').eq('id', id).single();
      if (target && target.role === 'admin' && admins && admins.length <= 1) return res.status(400).json({ error: 'Tidak bisa menghapus satu-satunya akun Owner.' });
      await supabase.from('users').delete().eq('id', id);
      return res.json("Sukses");
    }

    if (func === 'savePengaturan') {
      const data = body;
      await supabase.from('pengaturan').upsert([{ id: 1, nama_toko: data.nama, alamat: data.alamat, telp: data.telp, footer: data.footer, logo_toko: data.logoToko, logo_struk: data.logoStruk }]);
      return res.json("Sukses");
    }

    return res.status(404).json({ error: 'Function not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
