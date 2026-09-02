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

// ===== BARU: Helper tanggal WIB (UTC+7) =====
function wibDateStr(d) {
  return new Date(new Date(d).getTime() + 7 * 3600 * 1000).toISOString().split('T')[0];
}

function getRangeWib(startDate, endDate) {
  const todayStr = wibDateStr(Date.now());
  const startIso = new Date((startDate || todayStr) + 'T00:00:00+07:00').toISOString();
  const endIso = new Date((endDate || startDate || todayStr) + 'T23:59:59.999+07:00').toISOString();
  return { start: startIso, end: endIso };
}
// ===== BARU: Parse metode dari transaksi lama, contoh: "BCA (500000) + QRIS (250000)" =====
function parseMetodeStr(metodeStr, fallbackTotal) {
  if (!metodeStr) return [{ metode: 'Lainnya', jumlah: Number(fallbackTotal) || 0 }];
  if (String(metodeStr).indexOf(' + ') === -1) return [{ metode: metodeStr, jumlah: Number(fallbackTotal) || 0 }];
  return String(metodeStr).split(' + ').map(part => {
    const m = part.trim().match(/^(.*?)\s*\(([\d.,]+)\)$/);
    if (m) return { metode: m[1].trim(), jumlah: Number(String(m[2]).replace(/[.,]/g, '')) || 0 };
    return { metode: part.trim(), jumlah: 0 };
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { func } = req.query;
  const body = req.body || {};

  try {
    if (func === 'getPengaturan') {
      const { data } = await supabase.from('pengaturan').select('*').eq('id', 1).single();
      if (data) return res.json([data.nama_toko, data.alamat, data.telp, data.footer, data.logo_toko, data.logo_struk, data.qris_img, data.rek_bca, data.rek_mandiri, data.rek_gopay, data.rek_dana]);
      return res.json(['Benk cell', '', '', 'Terima kasih telah berbelanja!', '', '', '', '', '', '', '']);
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
      // index 12 = harga_modal (BARU, ditambahkan di paling belakang biar frontend lama tidak rusak)
      const mapped = (data || []).map(p => [p.id, p.nama, p.varian, p.storage, p.harga, p.stok, p.kategori, p.foto, p.imeis || [], p.is_konsinyasi || false, p.mitra_id || null, p.harga_setoran || 0, p.harga_modal || 0]);
      return res.json(mapped);
    }

    if (func === 'saveProduk') {
      const data = body;
      if (!data.nama || data.harga === '' || data.harga === undefined) return res.status(400).json({ error: 'Nama dan Harga wajib diisi.' });

           const payload = {
        id: data.id, nama: data.nama, varian: data.varian, storage: data.storage, 
        harga: Number(data.harga), stok: 0, 
        kategori: data.kategori, foto: data.foto, imeis: [],
harga_modal: Number(data.hpp) || 0,
             is_konsinyasi: data.isKonsinyasi || false,
        mitra_id: data.isKonsinyasi ? data.mitraId : null,
        harga_setoran: data.isKonsinyasi ? (Number(data.hargaSetoran) || 0) : 0
      };

      const { data: existing } = await supabase.from('produk').select('id').eq('id', data.id).single();
      if (existing) {
        const { data: currentProd } = await supabase.from('produk').select('stok, imeis').eq('id', data.id).single();
        payload.stok = currentProd.stok;
        payload.imeis = currentProd.imeis || [];
        await supabase.from('produk').update(payload).eq('id', data.id);
      } else {
        await supabase.from('produk').insert([payload]);
      }
      return res.json("Sukses");
    }

        if (func === 'simpanTransaksi') {
      const { keranjang, pelanggan, diskonStr, metode, ttNama, ttImei, ttNilai, masaGaransi, splitPayments, kasir } = body;

      const itemIds = keranjang.map(i => i.id);
      const { data: prods } = await supabase.from('produk').select('*').in('id', itemIds);
      const prodMap = {};
      (prods || []).forEach(p => prodMap[p.id] = p);

      for (let item of keranjang) {
        let prod = prodMap[item.id];
        if (!prod) return res.status(400).json({ error: 'Produk tidak ditemukan di database.' });
        if (item.imei) {
          let imeiExists = (prod.imeis || []).some(im => im.imei === item.imei && im.status === 'tersedia');
          if (!imeiExists) return res.status(400).json({ error: 'IMEI ' + item.imei + ' tidak tersedia untuk produk ' + prod.nama });
        } else {
          if (Number(item.qty) > Number(prod.stok)) return res.status(400).json({ error: 'Stok "' + prod.nama + '" tidak cukup.' });
        }
      }

            let total = 0;
      let hppTotal = 0;
      let itemsArr = [];
      let itemsJson = []; // BARU: detail lengkap untuk cetak ulang
      keranjang.forEach(item => {
        const qty = Number(item.qty) || 0;
        total += Number(item.harga) * qty;
        const prod = prodMap[item.id];
        const modalSatuan = prod.is_konsinyasi ? Number(prod.harga_setoran || 0) : Number(prod.harga_modal || 0);
        hppTotal += modalSatuan * qty;
        let storageTxt = item.storage ? ' (' + item.storage + ')' : '';
        let imeiTxt = item.imei ? ' [IMEI:' + item.imei + ']' : '';
        itemsArr.push(item.nama + ' ' + item.varian + storageTxt + imeiTxt + ' x' + item.qty);
        itemsJson.push({
          id: item.id, nama: item.nama, varian: item.varian || '',
          storage: item.storage || '', imei: item.imei || null,
          qty: qty, harga: Number(item.harga)
        });
      });

      let diskonRp = 0;
      if (String(diskonStr).indexOf('%') !== -1) diskonRp = (total * parseFloat(diskonStr)) / 100;
      else diskonRp = parseFloat(diskonStr) || 0;

            let nilaiTukar = Number(ttNilai) || 0;
      let totalAkhir = total - diskonRp - nilaiTukar;
      if (totalAkhir < 0) totalAkhir = 0; // tukar tambah tidak boleh bikin minus
      let tgl = new Date().toISOString();
      let idTrx = 'INV' + tgl.replace(/[-:T]/g, '').split('.')[0] + Math.floor(Math.random() * 90 + 10);
      
      let metodeBayarFinal = metode;
      // BARU: simpan rincian pembayaran terstruktur (untuk rekap per metode di laporan)
      let rincianBayar = [{ metode: metode, jumlah: totalAkhir }];
      if (splitPayments && splitPayments.length > 1) {
        metodeBayarFinal = splitPayments.map(p => p.metode + ' (' + p.jumlah + ')').join(' + ');
        rincianBayar = splitPayments.map(p => ({ metode: p.metode, jumlah: Number(p.jumlah) || 0 }));
      }

                  const { error: trxErr } = await supabase.from('transaksi').insert([{
        id: idTrx, tgl: tgl, pelanggan: pelanggan, items: itemsArr.join(', '),
        items_json: itemsJson,        // BARU
        kasir: kasir || null,         // BARU
        total: totalAkhir, hpp: hppTotal, metode: metodeBayarFinal, diskon: diskonStr,
        rincian_bayar: rincianBayar,
        tt_nama: ttNama || null, tt_imei: ttImei || null, tt_nilai: nilaiTukar
      }]);
      if (trxErr) return res.status(500).json({ error: 'Gagal simpan transaksi: ' + trxErr.message });
      
      let updatePromises = [];
      let mitraHutangMap = {};

      for (let item of keranjang) {
        let prod = prodMap[item.id];

        if (item.imei) {
          let newImeis = (prod.imeis || []).filter(im => im.imei !== item.imei);
          updatePromises.push(supabase.from('produk').update({ imeis: newImeis, stok: newImeis.length }).eq('id', item.id));
        } else {
          let newStok = Number(prod.stok) - Number(item.qty);
          updatePromises.push(supabase.from('produk').update({ stok: newStok }).eq('id', item.id));
        }

        if (Number(masaGaransi) > 0) {
          let warrantyId = 'GR' + Date.now() + Math.floor(Math.random() * 1000) + Math.floor(Math.random()*1000);
          let namaProduk = item.nama + ' ' + (item.varian || '') + (item.storage ? ' (' + item.storage + ')' : '');
          updatePromises.push(supabase.from('garansi').insert([{
            id: warrantyId,
            no_invoice: idTrx,
            tgl: tgl,
            imei: item.imei || '-',
            nama_produk: namaProduk,
            pelanggan: pelanggan,
            telp: '',
            masa_garansi: Number(masaGaransi)
          }]));
        }

        if (prod.is_konsinyasi && prod.mitra_id) {
          let tambahanHutang = Number(prod.harga_setoran || 0) * Number(item.qty);
          mitraHutangMap[prod.mitra_id] = (mitraHutangMap[prod.mitra_id] || 0) + tambahanHutang;
        }
      }

      for (let mitraId in mitraHutangMap) {
        let tambahan = mitraHutangMap[mitraId];
        updatePromises.push(
          supabase.from('mitra').select('hutang').eq('id', mitraId).single().then(({data}) => {
            if (data) return supabase.from('mitra').update({ hutang: Number(data.hutang) + tambahan }).eq('id', mitraId);
          })
        );
      }

      await Promise.all(updatePromises);
      return res.json({ status: "Sukses", idTrx: idTrx, total: totalAkhir, hpp: hppTotal, laba: totalAkhir - hppTotal });
    }

        // Hapus transaksi + kembalikan stok/IMEI + koreksi hutang mitra + hapus garansi
    if (func === 'deleteTransaksi') {
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'ID transaksi wajib diisi.' });
      const { data: trx } = await supabase.from('transaksi').select('*').eq('id', id).single();
      if (!trx) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });

      if (Array.isArray(trx.items_json)) {
        for (const it of trx.items_json) {
          const { data: p } = await supabase.from('produk')
            .select('stok, imeis, is_konsinyasi, mitra_id, harga_setoran').eq('id', it.id).single();
          if (!p) continue;
          if (it.imei) {
            const imeis = (p.imeis || []).filter(im => im.imei !== it.imei);
            imeis.push({ imei: it.imei, status: 'tersedia' });
            await supabase.from('produk').update({ imeis: imeis, stok: imeis.length }).eq('id', it.id);
          } else {
            await supabase.from('produk').update({ stok: Number(p.stok) + Number(it.qty || 0) }).eq('id', it.id);
          }
          if (p.is_konsinyasi && p.mitra_id) {
            const { data: m } = await supabase.from('mitra').select('hutang').eq('id', p.mitra_id).single();
            if (m) {
              let h = Number(m.hutang) - Number(p.harga_setoran || 0) * Number(it.qty || 0);
              await supabase.from('mitra').update({ hutang: Math.max(0, h) }).eq('id', p.mitra_id);
            }
          }
        }
      }
      await supabase.from('garansi').delete().eq('no_invoice', id);
      await supabase.from('transaksi').delete().eq('id', id);
      return res.json("Sukses");
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

    if (func === 'getMitra') {
      const { data } = await supabase.from('mitra').select('*').order('nama', { ascending: true });
      return res.json(data || []);
    }

    if (func === 'addMitra') {
      const { nama, telp } = body;
      if (!nama) return res.status(400).json({ error: "Nama mitra wajib diisi!" });
      let id = 'MTR' + Date.now();
      await supabase.from('mitra').insert([{ id: id, nama: nama, telp: telp || '', hutang: 0, piutang: 0 }]);
      return res.json("Sukses");
    }

    if (func === 'deleteMitra') {
      const { id } = body;
      await supabase.from('produk').update({ is_konsinyasi: false, mitra_id: null, harga_setoran: 0 }).eq('mitra_id', id);
      await supabase.from('mitra').delete().eq('id', id);
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

    if (func === 'addKonsinyasiKeluar') {
      const { mitraId, mitraNama, items, total } = body;
      let tgl = new Date().toISOString();
      let id = 'KK' + Date.now();

      let updatePromises = [];
      for (let item of items) {
        const { data: p } = await supabase.from('produk').select('*').eq('id', item.id).single();
        if (p) {
          if (item.imei) {
            let newImeis = (p.imeis || []).filter(im => im.imei !== item.imei);
            updatePromises.push(supabase.from('produk').update({ imeis: newImeis, stok: newImeis.length }).eq('id', item.id));
          } else {
            let newStok = Number(p.stok) - Number(item.qty);
            updatePromises.push(supabase.from('produk').update({ stok: newStok }).eq('id', item.id));
          }
        }
      }
      await Promise.all(updatePromises);

      let itemsStr = items.map(i => i.nama + (i.imei ? ' ['+i.imei+']' : ' x'+i.qty)).join(', ');

      await supabase.from('konsinyasi_keluar').insert([{
        id: id, tgl: tgl, mitra_id: mitraId, mitra_nama: mitraNama,
        items: itemsStr, total: total, status: 'Belum Lunas', terbayar: 0
      }]);

      const { data: mitra } = await supabase.from('mitra').select('piutang').eq('id', mitraId).single();
      if (mitra) {
        await supabase.from('mitra').update({ piutang: Number(mitra.piutang) + Number(total) }).eq('id', mitraId);
      }
      return res.json("Sukses");
    }

    if (func === 'getKonsinyasiKeluar') {
      const { data } = await supabase.from('konsinyasi_keluar').select('*').order('tgl', { ascending: false });
      return res.json(data || []);
    }

    if (func === 'lunasiKonsinyasiKeluar') {
      const { id, jumlah } = body;
      const { data: kk } = await supabase.from('konsinyasi_keluar').select('*').eq('id', id).single();
      if (kk) {
        let newTerbayar = Number(kk.terbayar || 0) + Number(jumlah);
        let status = newTerbayar >= Number(kk.total) ? 'Lunas' : 'Belum Lunas';
        await supabase.from('konsinyasi_keluar').update({ terbayar: newTerbayar, status: status }).eq('id', id);

        const { data: mitra } = await supabase.from('mitra').select('piutang').eq('id', kk.mitra_id).single();
        if (mitra) {
          let newPiutang = Number(mitra.piutang) - Number(jumlah);
          if (newPiutang < 0) newPiutang = 0;
          await supabase.from('mitra').update({ piutang: newPiutang }).eq('id', kk.mitra_id);
        }
        return res.json("Sukses");
      }
      return res.status(400).json({ error: "Data tidak ditemukan" });
    }

    if (func === 'getStokLog') {
      const { data } = await supabase.from('stok_log').select('*').order('tgl', { ascending: false }).limit(100);
      return res.json(data || []);
    }

    if (func === 'addStokMasuk') {
      const { produkId, produkNama, jumlah, keterangan, imeiText } = body;
      const { data: prod } = await supabase.from('produk').select('*').eq('id', produkId).single();
      if (prod) {
        let stokLama = Number(prod.stok);
        let newImeis = prod.imeis || [];
        let stokBaru = stokLama;
        let ket = keterangan || 'Restock';
        let jmlLog = 0;

        if (imeiText) {
          let newImeiList = String(imeiText).split('\n').map(s => s.trim()).filter(Boolean);
          newImeiList.forEach(i => newImeis.push({ imei: i, status: 'tersedia' }));
          stokBaru = stokLama + newImeiList.length;
          jmlLog = newImeiList.length;
          ket = 'Tambah IMEI (' + newImeiList.length + ' unit)';
          await supabase.from('produk').update({ stok: stokBaru, imeis: newImeis }).eq('id', produkId);
        } else {
          if (jumlah <= 0) return res.status(400).json({ error: "Jumlah tidak valid" });
          stokBaru = stokLama + Number(jumlah);
          jmlLog = Number(jumlah);
          await supabase.from('produk').update({ stok: stokBaru }).eq('id', produkId);
        }

                let id = 'LOG' + Date.now() + Math.floor(Math.random() * 900 + 100);
        let tgl = new Date().toISOString();
        await supabase.from('stok_log').insert([{
          id, tgl, produk_id: produkId, produk_nama: produkNama,
          tipe: 'masuk', jumlah: jmlLog, stok_sistem: stokLama, stok_fisik: stokBaru, keterangan: ket
        }]);
        return res.json("Sukses");
      }
      return res.status(400).json({ error: "Produk tidak ditemukan" });
    }

            if (func === 'addStokKeluar') {
      const { produkId, produkNama, jumlah, keterangan, imeiText, imei } = body;
      const { data: prod } = await supabase.from('produk').select('*').eq('id', produkId).single();
      if (!prod) return res.status(400).json({ error: "Produk tidak ditemukan" });

      let stokLama = Number(prod.stok) || 0;
      let newImeis = prod.imeis || [];
      let stokBaru = stokLama;
      let ket = keterangan || 'Rusak/Hilang';
      let jmlLog = 0;

      if (imeiText) {
        // Stok keluar via daftar IMEI (1 baris = 1 IMEI)
        let imeiList = String(imeiText).split('\n').map(s => s.trim()).filter(Boolean);
        if (imeiList.length === 0) return res.status(400).json({ error: "IMEI wajib diisi" });
        let notFound = [];
        imeiList.forEach(i => {
          let before = newImeis.length;
          newImeis = newImeis.filter(im => im.imei !== i);
          if (newImeis.length === before) notFound.push(i);
        });
        if (notFound.length > 0) return res.status(400).json({ error: 'IMEI tidak ditemukan di stok: ' + notFound.join(', ') });
        stokBaru = newImeis.length;
        jmlLog = imeiList.length;
        ket = 'Buang IMEI (' + imeiList.length + ' unit): ' + imeiList.join(', ');
        await supabase.from('produk').update({ stok: stokBaru, imeis: newImeis }).eq('id', produkId);
      } else if (imei) {
        newImeis = newImeis.filter(im => im.imei !== imei);
        stokBaru = newImeis.length;
        jmlLog = 1;
        ket = 'Buang IMEI: ' + imei;
        await supabase.from('produk').update({ stok: stokBaru, imeis: newImeis }).eq('id', produkId);
      } else {
        let jml = Number(jumlah);
        if (!jml || jml <= 0) return res.status(400).json({ error: "Jumlah tidak valid" });
        if (stokLama < jml) return res.status(400).json({ error: "Stok sistem tidak cukup" });
        stokBaru = stokLama - jml;
        jmlLog = jml;
        await supabase.from('produk').update({ stok: stokBaru }).eq('id', produkId);
      }

      let id = 'LOG' + Date.now() + Math.floor(Math.random() * 900 + 100);
      let tgl = new Date().toISOString();
      await supabase.from('stok_log').insert([{
        id, tgl, produk_id: produkId, produk_nama: produkNama,
        tipe: 'keluar', jumlah: -jmlLog, stok_sistem: stokLama, stok_fisik: stokBaru, keterangan: ket
      }]);
      return res.json("Sukses");
    }

    if (func === 'submitOpname') {
      const { items } = body;
      let promises = [];
      let logs = [];
      let tgl = new Date().toISOString();

      for (let item of items) {
        if (Number(item.stokSistem) !== Number(item.stokFisik)) {
          let selisih = Number(item.stokFisik) - Number(item.stokSistem);
          promises.push(supabase.from('produk').update({ stok: Number(item.stokFisik) }).eq('id', item.id));
          logs.push({
            id: 'LOG' + Date.now() + Math.floor(Math.random() * 1000),
            tgl, produk_id: item.id, produk_nama: item.nama,
            tipe: 'opname', jumlah: selisih, stok_sistem: Number(item.stokSistem), stok_fisik: Number(item.stokFisik),
            keterangan: 'Adjustment Opname'
          });
        }
      }

      if (logs.length > 0) {
        promises.push(supabase.from('stok_log').insert(logs));
      }

      await Promise.all(promises);
      return res.json("Sukses");
    }

    if (func === 'getRiwayatTransaksi') {
      const { startDate, endDate } = body;
      const { start, end } = getRangeWib(startDate, endDate);
      const { data, error: errTrx } = await supabase.from('transaksi').select('*').gte('tgl', start).lte('tgl', end).order('tgl', { ascending: false });
      if (errTrx) return res.status(500).json({ error: errTrx.message });
           const mapped = (data || []).map(row => ({
        id: row.id, tgl: row.tgl, pelanggan: row.pelanggan,
        items: row.items ? row.items.split(', ') : [],
        items_json: row.items_json || null,        // BARU
        rincian_bayar: row.rincian_bayar || null,  // BARU
        kasir: row.kasir || null,                  // BARU
        total: row.total,
        hpp: Number(row.hpp) || 0,
        laba: (Number(row.total) || 0) - (Number(row.hpp) || 0),
        metode: row.metode, diskon: row.diskon,
        tt_nama: row.tt_nama, tt_imei: row.tt_imei, tt_nilai: row.tt_nilai || 0
      }));
      return res.json(mapped);
    }

    if (func === 'getDashboardData') {
      const { startDate, endDate } = body;
      const { start, end } = getRangeWib(startDate, endDate);
      const { data: trxData } = await supabase.from('transaksi').select('*');
      const { data: prodData } = await supabase.from('produk').select('*');
      let penjualanPeriode = 0, hppPeriode = 0, trxPeriode = 0, totalStok = 0, lowStok = [];
      let chartLabels = [], chartData = [], chartDateMap = {};
      for (let i = 6; i >= 0; i--) {
        let d = new Date(); d.setDate(d.getDate() - i);
        let key = wibDateStr(d);
        let parts = key.split('-');
        chartLabels.push(parts[2] + '/' + parts[1]);
        chartData.push(0); chartDateMap[key] = chartLabels.length - 1;
      }
      (trxData || []).forEach(row => {
        let tglObj = new Date(row.tgl);
        let nilai = Number(row.total) || 0;
        let hpp = Number(row.hpp) || 0;
        let tglStr = wibDateStr(tglObj);
        if (tglObj >= new Date(start) && tglObj <= new Date(end)) {
          penjualanPeriode += nilai;
          hppPeriode += hpp;      // BARU
          trxPeriode++;
        }
        if (chartDateMap.hasOwnProperty(tglStr)) chartData[chartDateMap[tglStr]] += nilai;
      });
      (prodData || []).forEach(p => {
        let stok = p.imeis ? p.imeis.length : Number(p.stok);
        totalStok += stok;
        if (stok <= 5) lowStok.push({ id: p.id, nama: p.nama, varian: p.varian, stok: stok });
      });
      return res.json({
        penjualanPeriode,
        hppPeriode,                                        // BARU
        labaPeriode: penjualanPeriode - hppPeriode,        // BARU
        trxPeriode, totalTrx: trxData ? trxData.length : 0,
        totalProduk: prodData ? prodData.length : 0, totalStok, lowStok, chartLabels, chartData
      });
    }

    
    // ===== FUNGSI BARU: Laporan Harian (untuk cetak/report) =====
    if (func === 'getLaporanHarian') {
      const { startDate, endDate } = body;
      const { start, end } = getRangeWib(startDate, endDate);
      const todayStr = wibDateStr(Date.now());

      const { data: trxData, error } = await supabase.from('transaksi')
        .select('*').gte('tgl', start).lte('tgl', end).order('tgl', { ascending: true });
      if (error) throw error;

      let totalPenjualan = 0, totalHpp = 0;
      let metodeMap = {};
      let produkTerjual = {};
      let list = [];

      (trxData || []).forEach(row => {
        const total = Number(row.total) || 0;
        const hpp = Number(row.hpp) || 0;
        totalPenjualan += total;
        totalHpp += hpp;

        let rincian = (Array.isArray(row.rincian_bayar) && row.rincian_bayar.length > 0)
          ? row.rincian_bayar
          : parseMetodeStr(row.metode, total);
        rincian.forEach(r => {
          const key = String(r.metode || 'Lainnya').trim();
          metodeMap[key] = (metodeMap[key] || 0) + (Number(r.jumlah) || 0);
        });

        (row.items ? String(row.items).split(', ') : []).forEach(it => {
          const m = it.match(/ x(\d+)$/);
          const qty = m ? Number(m[1]) : 1;
          const nama = it.replace(/ x\d+$/, '').replace(/ \[IMEI:.*?\]/, '').trim();
          produkTerjual[nama] = (produkTerjual[nama] || 0) + qty;
        });

        list.push({
          id: row.id, tgl: row.tgl, pelanggan: row.pelanggan,
          items: row.items ? String(row.items).split(', ') : [],
          total: total, hpp: hpp, laba: total - hpp,
          metode: row.metode, diskon: row.diskon, tt_nilai: row.tt_nilai || 0
        });
      });

      return res.json({
        periode: { start: startDate || todayStr, end: endDate || startDate || todayStr },
        jumlahTransaksi: list.length,
        totalPenjualan, totalHpp, totalLaba: totalPenjualan - totalHpp,
        rincianMetode: metodeMap,
        produkTerjual: Object.keys(produkTerjual).map(n => ({ nama: n, qty: produkTerjual[n] })),
        transaksi: list
      });
    }
      if (func === 'bulkUpdateHpp') {
      const { items } = body;
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Data tidak valid.' });
      const payload = items
        .filter(it => it.id)
        .map(it => ({ id: it.id, harga_modal: Number(it.hpp) || 0 }));
      if (payload.length === 0) return res.status(400).json({ error: 'Data tidak valid.' });
      // Satu query untuk SEMUA produk: update kolom harga_modal saja, kolom lain tidak disentuh
      const { error } = await supabase.from('produk').upsert(payload, { onConflict: 'id' });
      if (error) return res.status(500).json({ error: 'Gagal simpan HPP: ' + error.message });
      return res.json("Sukses");
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
      await supabase.from('pengaturan').upsert([{
        id: 1,
        nama_toko: data.nama,
        alamat: data.alamat,
        telp: data.telp,
        footer: data.footer,
        logo_toko: data.logoToko,
        logo_struk: data.logoStruk,
        qris_img: data.qrisImg,
        rek_bca: data.rekBca,
        rek_mandiri: data.rekMandiri,
        rek_gopay: data.rekGopay,
        rek_dana: data.rekDana
      }]);
      return res.json("Sukses");
    }

    return res.status(404).json({ error: 'Function not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
