const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join('/tmp', 'db.json');

function hashPassword(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex');
}

function setupData() {
  if (!fs.existsSync(DB_PATH)) {
    const initialData = {
      produk: [],
      transaksi: [],
      users: [
        ['USR1', 'admin', hashPassword('admin123'), 'Owner', 'admin']
      ],
      pengaturan: [
        ['Benk cell', '', '', 'Terima kasih telah berbelanja!', '', '']
      ]
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
  }
}

function getDB() {
  setupData();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { func } = req.query;
  const body = req.body || {};
  const db = getDB();

  try {
    if (func === 'getPengaturan') {
      return res.json(db.pengaturan[0] || ['Benk cell', '', '', 'Terima kasih telah berbelanja!', '', '']);
    }

    if (func === 'getUsernamesForLogin') {
      const result = db.users.map(u => ({ username: u[1], full_name: u[3] }));
      return res.json(result);
    }

    if (func === 'login') {
      const { username, password } = body;
      const hashed = hashPassword(password || '');
      const user = db.users.find(u => String(u[1]).toLowerCase() === String(username || '').toLowerCase().trim());
      
      if (user) {
        const storedPass = String(user[2]);
        const match = (storedPass.length === 64 && storedPass === hashed) || (storedPass === password);
        if (match) {
          return res.json({ id: user[0], username: user[1], full_name: user[3], role: user[4] });
        }
      }
      return res.json(null);
    }

    if (func === 'getProduk') {
      return res.json(db.produk);
    }

    if (func === 'saveProduk') {
      const data = body;
      if (!data.nama || data.harga === '' || data.harga === undefined) {
        return res.status(400).json({ error: 'Nama dan Harga wajib diisi.' });
      }
      const idx = db.produk.findIndex(p => p[0] === data.id);
      const newRow = [data.id, data.nama, data.varian, data.storage, Number(data.harga), Number(data.stok) || 0, data.kategori, data.foto];
      if (idx > -1) db.produk[idx] = newRow;
      else db.produk.push(newRow);
      saveDB(db);
      return res.json("Sukses");
    }

    if (func === 'simpanTransaksi') {
      const { keranjang, pelanggan, diskonStr, metode } = body;
      let qtyPerId = {};
      keranjang.forEach(item => { qtyPerId[item.id] = (qtyPerId[item.id] || 0) + Number(item.qty); });

      for (let id in qtyPerId) {
        let prod = db.produk.find(p => p[0] === id);
        if (!prod) return res.status(400).json({ error: 'Produk tidak ditemukan di database.' });
        if (qtyPerId[id] > Number(prod[5])) return res.status(400).json({ error: 'Stok "' + prod[1] + ' - ' + prod[2] + '" tidak cukup.' });
      }

      let total = 0;
      let itemsArr = [];
      keranjang.forEach(item => {
        total += Number(item.harga) * Number(item.qty);
        let storageTxt = item.storage ? ' (' + item.storage + ')' : '';
        itemsArr.push(item.nama + ' ' + item.varian + storageTxt + ' x' + item.qty);
      });

      let diskonRp = 0;
      if (String(diskonStr).indexOf('%') !== -1) diskonRp = (total * parseFloat(diskonStr)) / 100;
      else diskonRp = parseFloat(diskonStr) || 0;

      let totalAkhir = total - diskonRp;
      let tgl = new Date().toISOString();
      let idTrx = 'INV' + new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];

      db.transaksi.push([idTrx, tgl, pelanggan, itemsArr.join(', '), totalAkhir, metode, diskonStr]);

      for (let id in qtyPerId) {
        let prod = db.produk.find(p => p[0] === id);
        prod[5] = Number(prod[5]) - qtyPerId[id];
      }
      saveDB(db);
      return res.json({ status: "Sukses", idTrx: idTrx, total: totalAkhir });
    }

    if (func === 'getRiwayatTransaksi') {
      const { startDate, endDate } = body;
      let now = new Date();
      let todayStr = now.toISOString().split('T')[0];
      let start = startDate || todayStr;
      let end = endDate || start;

      let result = [];
      db.transaksi.forEach(row => {
        let tglStr = new Date(row[1]).toISOString().split('T')[0];
        if (tglStr >= start && tglStr <= end) {
          result.push({ id: row[0], tgl: row[1], pelanggan: row[2], items: row[3] ? row[3].split(', ') : [], total: row[4], metode: row[5] });
        }
      });
      result.sort((a, b) => new Date(b.tgl) - new Date(a.tgl));
      return res.json(result);
    }

    if (func === 'getDashboardData') {
      const { startDate, endDate } = body;
      let now = new Date();
      let todayStr = now.toISOString().split('T')[0];
      let start = startDate || todayStr;
      let end = endDate || start;

      let penjualanPeriode = 0, trxPeriode = 0, totalStok = 0, lowStok = [];
      let chartLabels = [], chartData = [], chartDateMap = {};

      for (let i = 6; i >= 0; i--) {
        let d = new Date();
        d.setDate(d.getDate() - i);
        let key = d.toISOString().split('T')[0];
        chartLabels.push(d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' }));
        chartData.push(0);
        chartDateMap[key] = chartLabels.length - 1;
      }

      db.transaksi.forEach(row => {
        let tglObj = new Date(row[1]);
        let nilai = Number(row[4]) || 0;
        let tglStr = tglObj.toISOString().split('T')[0];
        if (tglStr >= start && tglStr <= end) { penjualanPeriode += nilai; trxPeriode++; }
        if (chartDateMap.hasOwnProperty(tglStr)) chartData[chartDateMap[tglStr]] += nilai;
      });

      db.produk.forEach(p => {
        let stok = Number(p[5]);
        totalStok += stok;
        if (stok <= 5) lowStok.push({ id: p[0], nama: p[1], varian: p[2], stok: stok });
      });

      return res.json({ penjualanPeriode, trxPeriode, totalTrx: db.transaksi.length, totalProduk: db.produk.length, totalStok, lowStok, chartLabels, chartData });
    }

    if (func === 'getUsers') {
      return res.json(db.users.map(u => ({ id: u[0], username: u[1], full_name: u[3], role: u[4] })));
    }

    if (func === 'addUser') {
      const { u, p, n, r } = body;
      if (!u || !p || !n) return res.status(400).json({ error: "Semua kolom wajib diisi!" });
      if (db.users.find(x => String(x[1]).toLowerCase() === u.toLowerCase())) return res.status(400).json({ error: "Username sudah dipakai!" });
      let id = 'USR' + Date.now();
      db.users.push([id, u, hashPassword(p), n, r]);
      saveDB(db);
      return res.json("Sukses");
    }

    if (func === 'resetUserPassword') {
      const { id, newPassword } = body;
      let user = db.users.find(u => u[0] === id);
      if (user) { user[2] = hashPassword(newPassword); saveDB(db); return res.json("Sukses"); }
      return res.status(400).json({ error: "User tidak ditemukan." });
    }

    if (func === 'deleteProduk') {
      const { id } = body;
      let idx = db.produk.findIndex(p => p[0] === id);
      if (idx > -1) { db.produk.splice(idx, 1); saveDB(db); return res.json("Sukses"); }
      return res.status(400).json({ error: "Produk tidak ditemukan" });
    }

    if (func === 'deleteUser') {
      const { id } = body;
      let adminCount = db.users.filter(u => u[4] === 'admin').length;
      let idx = db.users.findIndex(u => u[0] === id);
      if (idx > -1) {
        if (db.users[idx][4] === 'admin' && adminCount <= 1) return res.status(400).json({ error: 'Tidak bisa menghapus satu-satunya akun Owner.' });
        db.users.splice(idx, 1); saveDB(db); return res.json("Sukses");
      }
      return res.status(400).json({ error: "User tidak ditemukan" });
    }

    if (func === 'savePengaturan') {
      const data = body;
      db.pengaturan[0] = [data.nama, data.alamat, data.telp, data.footer, data.logoToko, data.logoStruk];
      saveDB(db);
      return res.json("Sukses");
    }

    return res.status(404).json({ error: 'Function not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
