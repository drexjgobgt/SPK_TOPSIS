# Dashboard SPK Pemilihan Kos (TOPSIS)

Dashboard keputusan untuk memilih kos di sekitar Kampus UINSU Tuntungan, Kota Medan.
Data dibaca dari Google Sheets, lalu seluruh perhitungan TOPSIS dijalankan ulang di peramban, bukan menyalin sel hasil.

Spreadsheet sumber:
https://docs.google.com/spreadsheets/d/140zFrdtspotuxfE3mTRzh7XldkYRHgWWWkzEJ7KlEbE/edit

## Menjalankan

Butuh Node.js 18 atau lebih baru (dipakai untuk `fetch` bawaan).

```
cd dashboard
node serve.js
```

Buka http://localhost:4321

Di Windows, `start.bat` melakukan dua langkah itu sekaligus.

## Versi tanpa server

`index.html` bisa dibuka langsung dari folder (dobel klik). Pada mode ini peramban mengambil CSV langsung dari Google, jadi tidak ada proxy lokal. Bila jaringan memblokir permintaan itu, buka menu **Sumber data** lalu tempel CSV manual (File, Download, Comma-separated values di spreadsheet).

## Menambah data mentah sendiri

Halaman **Data alternatif** punya formulir untuk menambah, mengubah, dan menghapus baris kos:

- Kode dibuat otomatis (A1, A2, dan seterusnya).
- Harga, jarak, luas, dan jarak minimarket menerima format Indonesia (`725.000`, `0,6`).
- Fasilitas, keamanan, dan kebersihan memakai skala 1 sampai 5 yang sama dengan sheet.
- Setiap perubahan langsung dihitung ulang dengan TOPSIS dan mengubah peringkat, angka ringkasan, serta grafik.
- Data disimpan di `localStorage` peramban, jadi tetap ada setelah halaman ditutup.
- **Kembali ke data sheet** membuang input lokal. **Unduh CSV** menyimpan data aktif dengan format kolom yang sama seperti blok data mentah sheet, siap ditempel kembali.
- Spreadsheet tidak pernah ditulis. Saat sinkron sheet berjalan, input lokal tetap dipakai sampai Anda meresetnya.

Status di kanan atas berubah menjadi **Data lokal** selama input sendiri aktif, agar angka tidak tertukar dengan angka sheet.

## Deploy

- Produksi: https://spktopsis.vercel.app
- Repositori: https://github.com/drexjgobgt/SPK_TOPSIS

Proyek Vercel memakai folder ini sebagai root, tanpa build step. Di produksi tidak ada proxy lokal, jadi `spk-topsis.js` langsung mengambil CSV `export` dari Google. `serve.js` hanya dipakai saat dijalankan di komputer sendiri.

## Koneksi data

| Jalur | Dipakai saat | Catatan |
| --- | --- | --- |
| `GET /api/sheet` | server lokal aktif | proxy di `serve.js`, cache 30 detik |
| `export?format=csv` | tanpa server, atau proxy gagal | CSV lengkap, semua kolom terbaca |
| `gviz/tq?tqx=out=csv` | cadangan terakhir | sel gabungan pada blok kriteria hilang, jadi hanya cadangan |

Urutan itu disengaja. CSV dari `gviz` menghilangkan kolom kode dan nama kriteria karena sel gabungan, sehingga `export` dipakai lebih dulu.

Peramban menyimpan salinan CSV terakhir di `localStorage`. Jika sinkron gagal, dashboard tetap terbuka memakai salinan itu dan menampilkan pemberitahuan, bukan halaman kosong.

Tombol **Sinkron data** mengambil ulang. **Sumber data** menyediakan sinkron otomatis tiap 5 atau 15 menit; pilihan disimpan di peramban.

## Yang dihitung

1. Matriks keputusan X dari blok data mentah. Kategori C3 sampai C5 dikonversi dengan skala 5 Sangat Baik, 4 Baik, 3 Cukup, 2 Kurang, 1 Sangat Kurang.
2. Normalisasi R: setiap nilai dibagi akar jumlah kuadrat kolomnya.
3. Matriks terbobot Y: R dikali bobot kriteria.
4. Solusi ideal A+ dan A-. Untuk kriteria cost, A+ adalah nilai terkecil.
5. Jarak D+ dan D- dengan Euclidean.
6. Nilai preferensi V = D- / (D+ + D-), lalu peringkat.

Halaman **Metode & validasi** membandingkan hasil hitung dengan blok B dan G pada spreadsheet. Pada data saat ini keempat pemeriksaan lolos dengan selisih 0,0000.

## Simulasi bobot

Halaman **Kriteria & bobot** punya slider untuk uji sensitivitas. Hasilnya hanya pratinjau di halaman itu: bobot dinormalisasi agar berjumlah 100%, dan spreadsheet tidak diubah. Tombol **Reset ke bobot sheet** mengembalikan nilai asli.

## Struktur

```
dashboard/
  index.html    kerangka halaman dan navigasi
  styles.css    palet, tata letak, mode terang dan gelap
  spk-topsis.js pembacaan CSV, hitung TOPSIS, editor data, render halaman
  serve.js      server statis dan proxy sheet, tanpa dependency
  vercel.json   konfigurasi deploy statis
  start.bat     pembuka cepat di Windows
```

Navigasi memakai hash (`#ringkasan`, `#perankingan`, `#matriks`, `#kriteria`, `#alternatif`, `#metode`, `#sumber`), jadi halaman bisa dibagikan lewat tautan dan tombol back tetap bekerja.

## Batas data

- Angka pada spreadsheet diberi keterangan oleh penyusunnya sebagai data ilustrasi latihan, bukan hasil survei lapangan.
- Dashboard hanya membaca. Tidak ada penulisan ke spreadsheet.
- Sheet harus dapat dibaca tanpa login (bagikan dengan tautan atau publikasikan).
- Format angka mengikuti Indonesia: koma untuk desimal, titik untuk ribuan.
