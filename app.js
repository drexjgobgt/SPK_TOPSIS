/* SPK Pemilihan Kos - TOPSIS
   Semua angka dihitung ulang di peramban dari matriks keputusan.
   Sumber data: Google Sheets (dibaca sebagai CSV, bukan HTML). */

(() => {
  "use strict";

  const SHEET_ID = "140zFrdtspotuxfE3mTRzh7XldkYRHgWWWkzEJ7KlEbE";
  const SHEET_EDIT = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/edit";
  const PROXY = "/api/sheet";
  const CSV_FALLBACKS = [
    "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv",
    "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=out:csv"
  ];

  const LS = {
    theme: "spk.theme",
    interval: "spk.interval",
    cache: "spk.cache.csv",
    cacheAt: "spk.cache.at",
    local: "spk.local.alts"
  };

  const KATEGORI = { 5: "Sangat Baik", 4: "Baik", 3: "Cukup", 2: "Kurang", 1: "Sangat Kurang" };

  /* localStorage bisa diblokir (mode privat, file://). Jangan sampai UI gagal karena itu. */
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* diabaikan */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* diabaikan */ }
    }
  };

  const VIEWS = {
    ringkasan: { title: "Ringkasan", sub: "Kos di sekitar Kampus UINSU Tuntungan, Kota Medan" },
    perankingan: { title: "Perankingan", sub: "Urutan alternatif dari nilai preferensi V tertinggi" },
    matriks: { title: "Matriks TOPSIS", sub: "Jejak perhitungan dari matriks keputusan sampai nilai preferensi" },
    kriteria: { title: "Kriteria & bobot", sub: "Tujuh kriteria, jenis, dan bobot yang dipakai sheet" },
    alternatif: { title: "Data alternatif", sub: "Tambah atau ubah data mentah, lalu lihat dampaknya pada peringkat" },
    metode: { title: "Metode & validasi", sub: "Langkah TOPSIS dan pemeriksaan hasil hitung terhadap sheet" },
    sumber: { title: "Sumber data", sub: "Koneksi spreadsheet, jadwal sinkron, dan impor manual" }
  };

  const state = {
    status: "loading",
    error: null,
    source: null,
    fetchedAt: null,
    model: null,
    baseModel: null,
    view: "ringkasan",
    tab: "X",
    selected: null,
    editing: null,
    simWeights: null,
    refreshTimer: null
  };

  const viewEl = document.getElementById("view");
  const titleEl = document.getElementById("view-title");
  const subEl = document.getElementById("view-sub");
  const nav = document.getElementById("nav");
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  const menuBtn = document.getElementById("menu-btn");
  const themeBtn = document.getElementById("theme-btn");
  const syncBtn = document.getElementById("sync-btn");
  const statusChip = document.getElementById("status-chip");
  const statusText = document.getElementById("status-text");
  const sideDot = document.getElementById("side-dot");
  const sideStatus = document.getElementById("side-status");
  const sideTime = document.getElementById("side-time");
  const sheetLink = document.getElementById("sheet-link");
  const toastEl = document.getElementById("toast");

  /* ---------------- util ---------------- */

  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));

  const num = (v, d) => {
    const n = Number(v);
    if (!isFinite(n)) return "-";
    return n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  const rupiah = (v) => "Rp " + Math.round(Number(v)).toLocaleString("id-ID");
  const pct = (v) => num(v * 100, 0) + "%";

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  function parseNum(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return raw;
    let s = String(raw).trim();
    if (!s) return null;
    const isPct = s.includes("%");
    s = s.replace(/[^\d,.\-]/g, "");
    if (!s || s === "-" || s === "," || s === ".") return null;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (hasComma) {
      s = s.replace(",", ".");
    } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, "");
    }
    let n = parseFloat(s);
    if (!isFinite(n)) return null;
    if (isPct) n = n / 100;
    return n;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    const src = String(text).replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i += 1) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; }
        } else if (c === "\r") {
          if (src[i + 1] !== "\n") cell += " ";
        } else if (c === "\n") {
          if (cell.trim() !== "" || true) cell += " ";
        } else {
          cell += c;
        }
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === ",") { row.push(cell); cell = ""; continue; }
      if (c === "\r") continue;
      if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
      cell += c;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }

  const cellText = (row, i) => (row && row[i] != null ? clean(row[i]) : "");

  function findRow(rows, needle, from = 0) {
    const target = needle.toLowerCase();
    for (let i = from; i < rows.length; i += 1) {
      const row = rows[i] || [];
      for (let j = 0; j < row.length; j += 1) {
        if (clean(row[j]).toLowerCase().includes(target)) return i;
      }
    }
    return -1;
  }

  /* ---------------- parser spreadsheet ---------------- */

  const KODE = 1, NAMA = 2, C1 = 3, C2 = 4, C3 = 5, C4 = 6, C5 = 7, C6 = 8, C7 = 9;

  const SCALE_FALLBACK = {
    "sangat baik": 5, baik: 4, cukup: 3, kurang: 2, "sangat kurang": 1
  };

  function scoreOf(raw, scaleMap) {
    const t = clean(raw).toLowerCase();
    if (t && scaleMap && Object.prototype.hasOwnProperty.call(scaleMap, t)) return scaleMap[t];
    if (t && Object.prototype.hasOwnProperty.call(SCALE_FALLBACK, t)) return SCALE_FALLBACK[t];
    return parseNum(raw);
  }

  function buildModel(rows) {
    const criteria = [];
    const iKrit = findRow(rows, "Data Alternatif dan Kriteria");
    if (iKrit >= 0) {
      for (let i = iKrit; i < Math.min(rows.length, iKrit + 24); i += 1) {
        const row = rows[i] || [];
        const code = cellText(row, 4);
        if (!/^C\d+$/i.test(code)) continue;
        const bobotRaw = cellText(row, 7);
        const bobot = parseNum(bobotRaw);
        criteria.push({
          kode: code.toUpperCase(),
          nama: cellText(row, 5) || code.toUpperCase(),
          jenis: cellText(row, 6).toLowerCase().startsWith("ben") ? "benefit" : "cost",
          bobot: bobot == null ? 0 : bobot,
          bobotRaw
        });
      }
    }
    if (!criteria.length) throw new Error("Blok kriteria (C1 sampai C7) tidak ditemukan di spreadsheet.");

    const scaleMap = {};
    const iSkala = findRow(rows, "Skala Penilaian");
    if (iSkala >= 0) {
      for (let i = iSkala; i < Math.min(rows.length, iSkala + 12); i += 1) {
        const row = rows[i] || [];
        const skor = parseNum(cellText(row, 1));
        const label = cellText(row, 2).toLowerCase();
        if (!label || skor == null) continue;
        if (skor >= 1 && skor <= 5 && /[a-z]/.test(label)) scaleMap[label] = skor;
      }
    }

    function readAlternatives(startIdx, mode) {
      const out = [];
      if (startIdx < 0) return out;
      for (let i = startIdx + 1; i < rows.length; i += 1) {
        const row = rows[i] || [];
        const kode = cellText(row, KODE);
        if (i > startIdx + 1 && !/^A\d+$/i.test(kode)) {
          if (out.length) break;
          continue;
        }
        if (!/^A\d+$/i.test(kode)) continue;
        const nama = cellText(row, NAMA);
        if (!nama) continue;
        if (mode === "raw") {
          if (!cellText(row, C1)) { if (out.length) break; continue; }
          out.push({
            kode: kode.toUpperCase(),
            nama,
            harga: parseNum(cellText(row, C1)),
            jarakKampus: parseNum(cellText(row, C2)),
            fasilitas: scoreOf(cellText(row, C3), scaleMap),
            keamanan: scoreOf(cellText(row, C4), scaleMap),
            kebersihan: scoreOf(cellText(row, C5), scaleMap),
            luas: parseNum(cellText(row, C6)),
            jarakMinimarket: parseNum(cellText(row, C7)),
            kategori: {
              fasilitas: cellText(row, C3),
              keamanan: cellText(row, C4),
              kebersihan: cellText(row, C5)
            },
            mode
          });
        } else {
          const vals = [C1, C2, C3, C4, C5, C6, C7].map((idx) => parseNum(cellText(row, idx)));
          if (vals.some((v) => v == null)) continue;
          out.push({
            kode: kode.toUpperCase(),
            nama,
            x: vals,
            harga: vals[0],
            jarakKampus: vals[1],
            fasilitas: vals[2],
            keamanan: vals[3],
            kebersihan: vals[4],
            luas: vals[5],
            jarakMinimarket: vals[6],
            kategori: {},
            mode
          });
        }
      }
      return out;
    }

    let alternatives = readAlternatives(findRow(rows, "Data Mentah Alternatif"), "raw");

    let sheetX = new Map();
    const iX = findRow(rows, "Matriks Keputusan (X)");
    if (iX >= 0) {
      const parsed = readAlternatives(iX, "x");
      parsed.forEach((a) => sheetX.set(a.kode, a.x));
      if (!alternatives.length) alternatives = parsed;
    }

    alternatives = alternatives.map((a) => {
      let x;
      if (a.mode === "x") {
        x = a.x;
      } else {
        x = [a.harga, a.jarakKampus, a.fasilitas, a.keamanan, a.kebersihan, a.luas, a.jarakMinimarket];
      }
      return Object.assign({}, a, { x });
    });

    const sheetV = new Map();
    const iV = findRow(rows, "Nilai Preferensi");
    if (iV >= 0) {
      for (let i = iV + 1; i < Math.min(rows.length, iV + 24); i += 1) {
        const row = rows[i] || [];
        const kode = cellText(row, KODE);
        if (!/^A\d+$/i.test(kode)) continue;
        const v = parseNum(cellText(row, 3));
        const rank = parseNum(cellText(row, 4));
        if (v != null) sheetV.set(kode.toUpperCase(), { v, rank });
      }
    }

    return { criteria, alternatives, scaleMap, sheetX, sheetV };
  }

  /* ---------------- hitung TOPSIS ---------------- */

  function topsis(criteria, alternatives, weightsOverride) {
    const n = alternatives.length;
    const m = criteria.length;
    const rawW = weightsOverride || criteria.map((c) => c.bobot);
    const wSum = rawW.reduce((a, b) => a + b, 0) || 1;
    const weights = rawW.map((w) => w / wSum);

    const X = alternatives.map((a) => a.x.map((v) => (isFinite(v) ? v : 0)));
    const div = [];
    for (let j = 0; j < m; j += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += X[i][j] * X[i][j];
      div[j] = Math.sqrt(s) || 1;
    }
    const R = X.map((row) => row.map((v, j) => v / div[j]));
    const Y = R.map((row) => row.map((v, j) => v * weights[j]));

    const ideal = criteria.map((c, j) => {
      const col = Y.map((row) => row[j]);
      const max = Math.max.apply(null, col);
      const min = Math.min.apply(null, col);
      return c.jenis === "benefit"
        ? { plus: max, minus: min }
        : { plus: min, minus: max };
    });

    const dist = Y.map((row) => {
      let dp = 0;
      let dm = 0;
      for (let j = 0; j < m; j += 1) {
        dp += Math.pow(row[j] - ideal[j].plus, 2);
        dm += Math.pow(row[j] - ideal[j].minus, 2);
      }
      return { dPlus: Math.sqrt(dp), dMinus: Math.sqrt(dm) };
    });

    const scored = alternatives.map((alt, i) => {
      const { dPlus, dMinus } = dist[i];
      const denom = dPlus + dMinus;
      return {
        alt,
        kode: alt.kode,
        nama: alt.nama,
        v: denom ? dMinus / denom : 0,
        dPlus,
        dMinus
      };
    });

    const ranking = scored
      .slice()
      .sort((a, b) => b.v - a.v)
      .map((s, i) => Object.assign({}, s, { rank: i + 1 }));

    return { weights, div, X, R, Y, ideal, dist, scored, ranking };
  }

  function validate(model, result) {
    const checks = [];
    const wSum = model.criteria.reduce((a, c) => a + c.bobot, 0);
    checks.push({
      label: "Bobot kriteria berjumlah 100%",
      ok: Math.abs(wSum - 1) < 0.005,
      detail: "Jumlah bobot " + pct(wSum)
    });

    const missing = model.alternatives.filter((a) => a.x.some((v) => v == null || !isFinite(v)));
    checks.push({
      label: "Semua alternatif punya nilai lengkap untuk 7 kriteria",
      ok: missing.length === 0,
      detail: missing.length ? missing.map((a) => a.kode).join(", ") + " belum lengkap" : model.alternatives.length + " alternatif terbaca"
    });

    if (model.localMode) {
      checks.push({
        label: "Data lokal dipakai, sheet tidak diubah",
        ok: true,
        detail: model.alternatives.length + " alternatif dari input lokal, perbandingan ke sheet dilewati"
      });
      return checks;
    }

    if (model.sheetX.size) {
      let maxDiff = 0;
      model.alternatives.forEach((a) => {
        const sx = model.sheetX.get(a.kode);
        if (!sx) return;
        a.x.forEach((v, j) => { maxDiff = Math.max(maxDiff, Math.abs(v - sx[j])); });
      });
      checks.push({
        label: "Konversi data mentah sama dengan matriks keputusan (B) di sheet",
        ok: maxDiff < 0.001,
        detail: "Selisih terbesar " + num(maxDiff, 4)
      });
    }

    if (model.sheetV.size) {
      let maxV = 0;
      result.scored.forEach((s) => {
        const sv = model.sheetV.get(s.kode);
        if (sv) maxV = Math.max(maxV, Math.abs(s.v - sv.v));
      });
      checks.push({
        label: "Nilai preferensi V sama dengan hasil di sheet",
        ok: maxV < 0.0006,
        detail: "Selisih terbesar " + num(maxV, 4)
      });
    }

    return checks;
  }

  function loadModel(csvText) {
    const rows = parseCsv(csvText);
    const base = buildModel(rows);
    const result = topsis(base.criteria, base.alternatives);
    const model = Object.assign({}, base, {
      result,
      validation: validate(base, result),
      altByKode: new Map(base.alternatives.map((a) => [a.kode, a]))
    });
    return model;
  }

  /* ---------------- data mentah milik pengguna ---------------- */

  const xOf = (a) => [a.harga, a.jarakKampus, a.fasilitas, a.keamanan, a.kebersihan, a.luas, a.jarakMinimarket];

  function nextKode(list) {
    const nums = list.map((a) => Number(String(a.kode || "").replace(/\D/g, "")) || 0);
    return "A" + (Math.max(0, Math.max.apply(null, nums)) + 1);
  }

  function readLocalRows() {
    try {
      const raw = store.get(LS.local);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || !saved.length) return null;
      const rows = saved.map((r, i) => ({
        kode: /^A\d+$/i.test(String(r.kode || "")) ? String(r.kode).toUpperCase() : "A" + (i + 1),
        nama: clean(r.nama) || "Tanpa nama",
        harga: parseNum(r.harga),
        jarakKampus: parseNum(r.jarakKampus),
        fasilitas: parseNum(r.fasilitas),
        keamanan: parseNum(r.keamanan),
        kebersihan: parseNum(r.kebersihan),
        luas: parseNum(r.luas),
        jarakMinimarket: parseNum(r.jarakMinimarket),
        status: r.status === "baru" ? "baru" : r.status === "sheet" ? "sheet" : "diubah"
      }));
      if (rows.some((r) => xOf(r).some((v) => v == null))) return null;
      return rows;
    } catch {
      return null;
    }
  }

  function persistLocal(model) {
    const rows = model.alternatives.map((a) => ({
      kode: a.kode,
      nama: a.nama,
      harga: a.harga,
      jarakKampus: a.jarakKampus,
      fasilitas: a.fasilitas,
      keamanan: a.keamanan,
      kebersihan: a.kebersihan,
      luas: a.luas,
      jarakMinimarket: a.jarakMinimarket,
      status: a.status || "sheet"
    }));
    store.set(LS.local, JSON.stringify(rows));
  }

  function recompute(model, rows) {
    const list = rows.map((r) => Object.assign({}, r, {
      x: xOf(r),
      mode: "local",
      kategori: {
        fasilitas: KATEGORI[r.fasilitas] || "",
        keamanan: KATEGORI[r.keamanan] || "",
        kebersihan: KATEGORI[r.kebersihan] || ""
      }
    }));
    const result = topsis(model.criteria, list);
    const next = Object.assign({}, model, {
      alternatives: list,
      result,
      altByKode: new Map(list.map((a) => [a.kode, a])),
      localMode: true
    });
    next.validation = validate(next, result);
    return next;
  }

  function applySavedLocal(base) {
    const rows = readLocalRows();
    return rows ? recompute(base, rows) : base;
  }

  function prepareModel(base) {
    state.baseModel = base;
    return applySavedLocal(base);
  }

  /* ---------------- pengambilan data ---------------- */

  async function fetchText(url, ms = 14000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (/<html/i.test(text.slice(0, 200))) throw new Error("Balasan berupa halaman HTML, bukan CSV");
      if (!text.trim()) throw new Error("Balasan kosong");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchSheet() {
    const attempts = [];
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    if ((location.protocol === "http:" || location.protocol === "https:") && localHost) {
      attempts.push({ url: PROXY, source: "server" });
    }
    CSV_FALLBACKS.forEach((u, i) => attempts.push({ url: u, source: i === 0 ? "export" : "gviz" }));

    let lastErr = null;
    for (const a of attempts) {
      try {
        const text = await fetchText(a.url);
        if (!/PEMILIHAN KOS|Harga Sewa/i.test(text)) throw new Error("Isi bukan sheet pemilihan kos");
        return { text, source: a.source };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Semua sumber gagal");
  }

  function setStatus(kind, text) {
    state.status = kind;
    statusChip.dataset.state = kind;
    statusText.textContent = text;
    sideDot.dataset.state = kind;
    sideStatus.textContent =
      kind === "live" ? "Tersambung ke spreadsheet" :
      kind === "loading" ? "Mengambil data" :
      kind === "manual" ? "Data impor manual" :
      kind === "local" ? "Data lokal aktif" :
      kind === "cache" ? "Memakai cache lokal" : "Sinkron gagal";
  }

  function restoreSourceStatus() {
    if (state.source === "cache") setStatus("cache", "Cache lokal");
    else if (state.source === "manual") setStatus("manual", "Impor manual");
    else setStatus("live", "Live sheet");
  }

  function stamp(date) {
    return date.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  async function load(opts) {
    const silent = !!(opts && opts.silent);
    if (!silent) {
      setStatus("loading", "Memuat");
      syncBtn.disabled = true;
      syncBtn.textContent = "Mengambil...";
      if (!state.model) renderLoading();
    }
    try {
      const { text, source } = await fetchSheet();
      const model = prepareModel(loadModel(text));
      state.model = model;
      state.error = null;
      state.source = source;
      state.fetchedAt = new Date();
      state.simWeights = null;
      state.selected = null;
      store.set(LS.cache, text);
      store.set(LS.cacheAt, String(state.fetchedAt.getTime()));
      setStatus(model.localMode ? "local" : "live", model.localMode ? "Data lokal" : "Live sheet");
      render();
      if (silent) toast("Data diperbarui dari spreadsheet.");
    } catch (err) {
      const cached = store.get(LS.cache);
      if (cached) {
        try {
          state.model = prepareModel(loadModel(cached));
          state.source = "cache";
          const at = Number(store.get(LS.cacheAt));
          state.fetchedAt = at ? new Date(at) : null;
          state.error = err;
          setStatus(state.model.localMode ? "local" : "cache", state.model.localMode ? "Data lokal" : "Cache lokal");
          render();
          toast("Sheet tidak terjangkau, memakai cache terakhir.", "error");
        } catch (inner) {
          fail(err);
        }
      } else {
        fail(err);
      }
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = "Sinkron data";
      updateMeta();
    }
  }

  function fail(err) {
    state.model = null;
    state.error = err;
    setStatus("error", "Gagal");
    renderError(err);
  }

  function updateMeta() {
    sideTime.textContent = state.fetchedAt ? "Sinkron " + stamp(state.fetchedAt) : "Belum ada sinkronisasi";
    sheetLink.href = SHEET_EDIT;
    if (state.model) {
      document.getElementById("foot-sheet").textContent = "TOPSIS pemilihan kos (ID " + SHEET_ID.slice(0, 8) + "...)";
    }
  }

  /* ---------------- render: kerangka ---------------- */

  function renderLoading() {
    viewEl.setAttribute("aria-busy", "true");
    viewEl.innerHTML =
      '<div class="loading-grid" aria-hidden="true">' +
        '<div class="sk sk-hero"><div class="sk-body">' +
          '<span class="sl" style="width:38%"></span>' +
          '<span class="sl sl-lg" style="width:62%"></span>' +
          '<span class="sl" style="width:48%"></span>' +
          '<span class="sl sl-xl" style="width:32%"></span>' +
        "</div></div>" +
        '<div class="sk sk-fig"><div class="sk-body sk-cells">' +
          '<span class="sl sl-box"></span><span class="sl sl-box"></span>' +
          '<span class="sl sl-box"></span><span class="sl sl-box"></span>' +
        "</div></div>" +
        '<div class="sk sk-line"><div class="sk-body">' +
          '<span class="sl" style="width:24%"></span>' +
          '<span class="sl" style="width:86%"></span>' +
          '<span class="sl" style="width:70%"></span>' +
        "</div></div>" +
        '<div class="sk sk-line"><div class="sk-body">' +
          '<span class="sl" style="width:30%"></span>' +
          '<span class="sl" style="width:78%"></span>' +
        "</div></div>" +
      "</div>" +
      '<p class="tiny" style="margin-top:14px" role="status">Mengambil data dari Google Sheets dan menghitung ulang TOPSIS.</p>';
  }

  function renderError() {
    viewEl.setAttribute("aria-busy", "false");
    viewEl.innerHTML =
      '<div class="state" data-tone="error" role="alert">' +
        "<h2>Spreadsheet tidak bisa dibaca</h2>" +
        "<p>" + esc(state.error && state.error.message ? state.error.message : "Koneksi gagal") + "</p>" +
        '<p class="tiny">Kemungkinan penyebab: tidak ada koneksi internet, ID sheet berubah, atau sheet tidak lagi bisa diakses tanpa login. Kamu tetap bisa menempel CSV manual.</p>' +
        '<div class="state-actions">' +
          '<button class="btn btn-primary btn-sm" type="button" data-retry>Coba lagi</button>' +
          '<a class="btn btn-sm" href="#sumber" data-goto="sumber">Impor CSV manual</a>' +
          '<a class="btn btn-sm" href="' + SHEET_EDIT + '" target="_blank" rel="noopener">Buka spreadsheet</a>' +
        "</div>" +
      "</div>";
  }

  function emptyState(title, body, action) {
    return '<div class="state"><h2>' + esc(title) + "</h2><p>" + esc(body) + "</p>" +
      (action || "") + "</div>";
  }

  /* ---------------- komponen ---------------- */

  function scale5(score, accent) {
    const n = Math.max(0, Math.min(5, Math.round(Number(score) || 0)));
    let out = '<span class="scale5' + (accent ? '" data-accent="true' : "") + '" aria-hidden="true">';
    for (let i = 1; i <= 5; i += 1) out += '<i data-on="' + (i <= n) + '"></i>';
    out += "</span>";
    return out;
  }

  function rankBadge(rank) {
    return '<span class="rank-badge" data-top="' + (rank === 1) + '">' + rank + "</span>";
  }

  function panel(kind) {
    return kind === "dark" ? "panel panel-dark" : "panel";
  }

  function chartWidth(container) {
    const avail = (container || viewEl).clientWidth || 640;
    return Math.max(280, Math.min(760, Math.round(avail)));
  }

  function barChart(ranking, width) {
    const w = width || chartWidth();
    const compact = w < 470;
    const rowH = compact ? 32 : 36;
    const padTop = 24;
    const padBottom = 26;
    const left = compact ? 84 : 116;
    const right = compact ? 48 : 56;
    const h = padTop + ranking.length * rowH + padBottom;
    const plotW = w - left - right;
    const maxChars = Math.max(9, Math.floor((left - 12) / 5.6));
    let svg =
      '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Diagram batang nilai preferensi tiap alternatif. Nilai tertinggi ' +
      esc(ranking[0].nama) + " dengan V " + num(ranking[0].v, 4) + '.">';

    for (let t = 0; t <= 4; t += 1) {
      const val = t / 4;
      const x = left + plotW * val;
      svg += '<line class="grid-line" x1="' + x + '" y1="' + (padTop - 8) + '" x2="' + x + '" y2="' + (h - padBottom + 2) + '"/>';
      svg += '<text x="' + x + '" y="' + (h - 8) + '" text-anchor="middle">' + num(val, 2) + "</text>";
    }

    ranking.forEach((r, i) => {
      const y = padTop + i * rowH;
      const barH = compact ? 13 : 12;
      const bw = Math.max(2, r.v * plotW);
      const top = i === 0;
      const label = r.nama.length > maxChars ? r.nama.slice(0, maxChars - 1) + "..." : r.nama;
      svg += '<text x="' + (left - 8) + '" y="' + (y + barH - 2) + '" text-anchor="end">' + esc(label) + "</text>";
      svg += '<rect class="' + (top ? "bar-top" : "bar") + '" x="' + left + '" y="' + y + '" width="' + bw + '" height="' + barH + '" rx="1"/>';
      svg += '<text x="' + (left + bw + 7) + '" y="' + (y + barH - 2) + '">' + num(r.v, 4) + "</text>";
    });

    svg += '<line class="axis" x1="' + left + '" y1="' + (padTop - 8) + '" x2="' + left + '" y2="' + (h - padBottom + 2) + '"/>';
    svg += "</svg>";
    return svg;
  }

  function scatter(ranking, width) {
    const w = width || chartWidth();
    const h = Math.max(300, Math.min(430, Math.round(w * 0.8)));
    const padL = w < 470 ? 42 : 52;
    const padR = 24;
    const padT = 24;
    const padB = 46;
    const xs = ranking.map((r) => r.dPlus);
    const ys = ranking.map((r) => r.dMinus);
    const xMin = 0;
    const xMax = Math.max.apply(null, xs) * 1.14;
    const yMin = 0;
    const yMax = Math.max.apply(null, ys) * 1.14;
    const px = (v) => padL + ((v - xMin) / (xMax - xMin)) * (w - padL - padR);
    const py = (v) => h - padB - ((v - yMin) / (yMax - yMin)) * (h - padT - padB);

    let svg =
      '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Sebaran jarak setiap alternatif ke solusi ideal positif (D+) dan solusi ideal negatif (D-). Titik paling dekat solusi ideal ada di sudut kiri atas.">';
    let svgGrid = "";
    for (let t = 0; t <= 4; t += 1) {
      const gx = px((xMax / 4) * t);
      const gy = py((yMax / 4) * t);
      svgGrid += '<line class="grid-line" x1="' + gx + '" y1="' + padT + '" x2="' + gx + '" y2="' + (h - padB) + '"/>';
      svgGrid += '<line class="grid-line" x1="' + padL + '" y1="' + gy + '" x2="' + (w - padR) + '" y2="' + gy + '"/>';
      svgGrid += '<text x="' + gx + '" y="' + (h - padB + 16) + '" text-anchor="middle">' + num((xMax / 4) * t, 2) + "</text>";
      svgGrid += '<text x="' + (padL - 8) + '" y="' + (gy + 4) + '" text-anchor="end">' + num((yMax / 4) * t, 2) + "</text>";
    }
    svg += svgGrid;

    ranking.forEach((r, i) => {
      const top = r.rank === 1;
      const cx = px(r.dPlus);
      const cy = py(r.dMinus);
      const lift = i % 2 === 1;
      svg += '<circle class="' + (top ? "point-top" : "point") + '" cx="' + cx + '" cy="' + cy + '" r="' + (top ? 7 : 5) + '"/>';
      svg += '<text class="' + (top ? "point-label point-label-top" : "point-label") + '" x="' + (cx + 9) + '" y="' + (cy + (lift ? -8 : 14)) + '">' + esc(r.kode) + "</text>";
    });

    svg += '<line class="axis" x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (h - padB) + '"/>';
    svg += '<line class="axis" x1="' + padL + '" y1="' + (h - padB) + '" x2="' + (w - padR) + '" y2="' + (h - padB) + '"/>';
    svg += '<text x="' + (padL + (w - padL - padR) / 2) + '" y="' + (h - 6) + '" text-anchor="middle">' + (w < 470 ? "D+, makin kecil makin baik" : "D+ (jarak ke solusi ideal positif), makin kecil makin baik") + "</text>";
    svg += '<text transform="translate(12 ' + (padT + (h - padT - padB) / 2) + ') rotate(-90)" text-anchor="middle">D- ke solusi ideal negatif</text>';
    svg += '<text x="' + (padL + 6) + '" y="' + (padT + 12) + '" class="point-label">sudut ideal</text>';
    svg += "</svg>";
    return svg;
  }

  function rankingTable(ranking, opts) {
    const o = opts || {};
    const rows = o.limit ? ranking.slice(0, o.limit) : ranking;
    let html =
      '<div class="table-wrap"><table>' +
      "<caption>Peringkat dihitung dari nilai preferensi V = D- / (D+ + D-). Baris disorot adalah peringkat 1.</caption>" +
      "<thead><tr>" +
        '<th scope="col" class="num">Peringkat</th>' +
        '<th scope="col" class="code">Kode</th>' +
        '<th scope="col">Alternatif</th>' +
        '<th scope="col" class="num">V</th>' +
        '<th scope="col" class="num">D+</th>' +
        '<th scope="col" class="num">D-</th>' +
        (o.noPick ? "" : '<th scope="col"><span class="tiny">Detail</span></th>') +
      "</tr></thead><tbody>";

    rows.forEach((r) => {
      const top = r.rank === 1;
      html += '<tr class="' + (top ? "is-top" : "") + '" data-row="' + esc(r.kode) + '"' +
        (state.selected === r.kode ? ' data-selected="true"' : "") + ">" +
        '<td class="num">' + rankBadge(r.rank) + "</td>" +
        '<td class="code">' + esc(r.kode) + "</td>" +
        "<td>" + esc(r.nama) + "</td>" +
        '<td class="num"><span class="v-cell"><span class="v-bar" data-top="' + top + '" aria-hidden="true"><i style="width:' + Math.round(r.v * 100) + '%"></i></span>' + num(r.v, 4) + "</span></td>" +
        '<td class="num">' + num(r.dPlus, 4) + "</td>" +
        '<td class="num">' + num(r.dMinus, 4) + "</td>" +
        (o.noPick ? "" :
          '<td><button class="link-btn" type="button" data-pick="' + esc(r.kode) + '"' +
          (o.detail ? ' aria-expanded="' + (state.selected === r.kode) + '" aria-controls="detail-body"' : "") +
          ' aria-label="Lihat detail ' + esc(r.nama) + '">Lihat</button></td>') +
        "</tr>";
    });

    html += "</tbody></table></div>";
    return html;
  }

  function detailPanel(model) {
    if (!state.selected) {
      return '<div class="detail-empty">Pilih salah satu alternatif lewat tombol <b>Lihat</b> untuk melihat nilai kriteria, jarak ke solusi ideal, dan kontribusinya.</div>';
    }
    const alt = model.altByKode.get(state.selected);
    const res = model.result.scored.find((s) => s.kode === state.selected);
    const rank = model.result.ranking.find((r) => r.kode === state.selected);
    if (!alt || !res) return '<div class="detail-empty">Alternatif tidak ditemukan pada data terbaru.</div>';

    const labels = ["Harga sewa", "Jarak ke kampus", "Fasilitas", "Keamanan", "Kebersihan", "Luas kamar", "Jarak minimarket"];
    const yRow = model.result.Y[model.alternatives.indexOf(alt)];
    let items = "";
    model.criteria.forEach((c, j) => {
      const val = alt.x[j];
      let shown;
      if (j === 0) shown = rupiah(val);
      else if (j === 5) shown = num(val, 0) + " m²";
      else if (j === 2 || j === 3 || j === 4) shown = num(val, 0) + " / 5";
      else shown = num(val, 1) + " km";
      const contrib = yRow[j];
      items +=
        '<div class="detail-item">' +
          "<span>" + esc(labels[j]) + '<br><span class="tiny">' + esc(c.kode) + " &middot; " + (c.jenis === "benefit" ? "benefit" : "cost") + " &middot; bobot " + pct(model.result.weights[j]) + "</span></span>" +
          '<span style="text-align:right">' + esc(shown) + '<br><span class="tiny">y = ' + num(contrib, 4) + "</span></span>" +
        "</div>";
    });

    const isTop = rank && rank.rank === 1;
    return (
      '<div class="detail-head">' +
        "<div><p class=\"tiny\">" + esc(alt.kode) + "</p>" +
        '<h3 class="detail-name">' + esc(alt.nama) + "</h3></div>" +
        (rank ? rankBadge(rank.rank) : "") +
      "</div>" +
      '<div class="winner-meta" style="color:var(--ink-soft);margin-top:3px">' +
        "<span>D+ " + num(res.dPlus, 4) + "</span><span>D- " + num(res.dMinus, 4) + "</span><span>V <b>" + num(res.v, 4) + "</b></span>" +
      "</div>" +
      '<div class="detail-list">' + items + "</div>" +
      (isTop
        ? '<p class="tiny" style="margin-top:10px">Alternatif ini berada di peringkat 1 pada bobot spreadsheet.</p>'
        : '<p class="tiny" style="margin-top:10px">Selisih V terhadap peringkat 1: ' +
          num(model.result.ranking[0].v - res.v, 4) + ".</p>")
    );
  }

  /* ---------------- view: ringkasan ---------------- */

  function viewRingkasan(model) {
    const r = model.result.ranking;
    if (!r.length) return emptyState("Belum ada alternatif", "Spreadsheet tidak memuat baris alternatif yang lengkap.");
    const top = r[0];
    const second = r[1];
    const margin = second ? top.v - second.v : 0;
    const alt = model.altByKode.get(top.kode);
    const benefit = model.criteria.filter((c) => c.jenis === "benefit").length;
    const cost = model.criteria.length - benefit;
    const heaviest = model.criteria.slice().sort((a, b) => b.bobot - a.bobot)[0];

    let segments = "";
    const filled = Math.round(top.v * 20);
    for (let i = 0; i < 20; i += 1) segments += '<span class="meter-seg" data-on="' + (i < filled) + '"></span>';

    return (
      '<div class="view-grid">' +
        '<section class="winner" aria-labelledby="winner-name">' +
          '<div class="winner-top">' +
            '<p class="winner-label">Rekomendasi utama, peringkat 1 dari ' + r.length + "</p>" +
            '<span class="winner-rank">' + esc(top.kode) + "</span>" +
          "</div>" +
          '<h2 class="winner-name" id="winner-name">' + esc(top.nama) + "</h2>" +
          '<div class="winner-meta">' +
            "<span>" + rupiah(alt.harga) + " / bulan</span>" +
            "<span>" + num(alt.jarakKampus, 1) + " km ke kampus</span>" +
            "<span>" + num(alt.luas, 0) + " m²</span>" +
          "</div>" +
          '<div class="winner-v">' +
            '<p class="winner-v-value">' + num(top.v, 4) + "</p>" +
            '<p class="winner-v-cap">nilai preferensi V (0 sampai 1). Makin dekat 1, makin dekat ke solusi ideal.</p>' +
          "</div>" +
          '<div class="meter-track" role="img" aria-label="Proporsi nilai preferensi ' + num(top.v, 4) + ' dari 1">' + segments + "</div>" +
        "</section>" +

        '<div class="figures">' +
          '<div class="figure"><p class="figure-value">' + model.alternatives.length + '</p><p class="figure-label">Alternatif dinilai</p><p class="figure-sub">kos pada data mentah</p></div>' +
          '<div class="figure"><p class="figure-value">' + model.criteria.length + '</p><p class="figure-label">Kriteria</p><p class="figure-sub">' + benefit + " benefit, " + cost + " cost</p></div>" +
          '<div class="figure"><p class="figure-value">' + pct(heaviest.bobot) + '</p><p class="figure-label">Bobot terbesar</p><p class="figure-sub">' + esc(heaviest.nama) + "</p></div>" +
          '<div class="figure"><p class="figure-value">' + num(margin, 4) + '</p><p class="figure-label">Selisih V puncak</p><p class="figure-sub">' + (second ? esc(top.nama) + " vs " + esc(second.nama) : "-") + "</p></div>" +
        "</div>" +

        '<section class="panel span-7" aria-labelledby="chart-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Sebaran nilai</p><h2 class="panel-title" id="chart-title">Nilai preferensi semua alternatif</h2></div>' +
            '<p class="panel-note">Batang amber menandai peringkat 1.</p></div>' +
          '<div class="chart-mount" data-chart="bar"></div>' +
          '<div class="legend"><span><i class="amber"></i>Peringkat 1</span><span><i></i>Alternatif lain</span></div>' +
        "</section>" +

        '<section class="panel span-5" aria-labelledby="weights-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Pembobotan</p><h2 class="panel-title" id="weights-title">Bobot kriteria</h2></div></div>' +
          criteriaList(model) +
          '<p class="tiny" style="margin-top:12px">Bobot dibaca dari sheet dan dipakai apa adanya setelah dinormalisasi.</p>' +
        "</section>" +

        '<section class="panel span-12" aria-labelledby="quick-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Papan peringkat</p><h2 class="panel-title" id="quick-title">Lima teratas</h2></div>' +
            '<a class="link-btn" href="#perankingan" data-goto="perankingan">Semua ' + r.length + " alternatif</a></div>" +
          rankingTable(r, { limit: 5 }) +
        "</section>" +
      "</div>"
    );
  }

  function criteriaList(model) {
    const maxW = Math.max.apply(null, model.criteria.map((c) => c.bobot));
    return '<div class="crit-list">' + model.criteria.map((c) =>
      '<div class="crit-row">' +
        '<p class="crit-name">' + esc(c.nama) + ' <span class="crit-tag" data-jenis="' + c.jenis + '">' + esc(c.kode) + " " + (c.jenis === "benefit" ? "benefit" : "cost") + "</span></p>" +
        '<p class="crit-weight">' + pct(c.bobot) + "</p>" +
        '<span class="crit-bar" data-benefit="' + (c.jenis === "benefit") + '" aria-hidden="true"><i style="width:' + Math.round((c.bobot / maxW) * 100) + '%"></i></span>' +
        '<span class="tiny" style="grid-column:1/-1;margin-top:-2px">' + (c.jenis === "benefit" ? "semakin besar semakin baik" : "semakin kecil semakin baik") + "</span>" +
      "</div>").join("") + "</div>";
  }

  /* ---------------- view: perankingan ---------------- */

  function viewPerankingan(model) {
    const r = model.result.ranking;
    return (
      '<div class="view-grid">' +
        '<section class="panel span-8" aria-labelledby="rank-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Hasil akhir</p><h2 class="panel-title" id="rank-title">Peringkat lengkap</h2></div>' +
          '<p class="panel-note">Urut menurun berdasarkan V.</p></div>' +
          '<div class="table-scroll">' + rankingTable(r, { detail: true }) + "</div>" +
        "</section>" +
        '<section class="panel span-4" aria-labelledby="detail-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Rincian</p><h2 class="panel-title" id="detail-title">Profil alternatif</h2></div></div>' +
          '<div id="detail-body">' + detailPanel(model) + "</div>" +
        "</section>" +
        '<section class="panel span-7" aria-labelledby="scatter-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Peta jarak</p><h2 class="panel-title" id="scatter-title">Kedekatan ke solusi ideal</h2></div>' +
          '<p class="panel-note">Kiri atas paling dekat ke solusi ideal.</p></div>' +
          '<div class="chart-mount" data-chart="scatter"></div>' +
          '<div class="legend"><span><i class="amber"></i>Peringkat 1</span><span><i></i>Alternatif lain</span></div>' +
        "</section>" +
        '<section class="panel span-5" aria-labelledby="dist-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Jarak</p><h2 class="panel-title" id="dist-title">D+ dan D-</h2></div></div>' +
          '<div class="table-wrap"><table><caption>Semakin kecil D+ dan semakin besar D-, nilai V makin tinggi.</caption>' +
          '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Alternatif</th><th scope="col" class="num">D+</th><th scope="col" class="num">D-</th><th scope="col" class="num">V</th></tr></thead><tbody>' +
          r.map((x) =>
            "<tr><td class=\"code\">" + esc(x.kode) + "</td><td>" + esc(x.nama) + "</td>" +
            '<td class="num">' + num(x.dPlus, 4) + '</td><td class="num">' + num(x.dMinus, 4) + '</td><td class="num">' + num(x.v, 4) + "</td></tr>").join("") +
          "</tbody></table></div>" +
        "</section>" +
      "</div>"
    );
  }

  /* ---------------- view: matriks ---------------- */

  const MATRIX_TABS = [
    { id: "X", label: "Keputusan (X)" },
    { id: "R", label: "Normalisasi (R)" },
    { id: "Y", label: "Terbobot (Y)" },
    { id: "ideal", label: "Solusi ideal" },
    { id: "jarak", label: "Jarak D+ / D-" },
    { id: "V", label: "Preferensi (V)" }
  ];

  function matrixTable(model) {
    const res = model.result;
    const crit = model.criteria;
    const alts = model.alternatives;
    const tab = state.tab;

    if (tab === "ideal") {
      return (
        '<div class="formula">A<b>+</b> = nilai terbaik per kriteria, A<b>-</b> = nilai terburuk. Benefit: A+ maksimum. Cost: A+ minimum.</div>' +
        '<div class="table-wrap"><table><caption>Hasil terbobot pada matriks Y, dipisah menurut jenis kriteria.</caption>' +
        "<thead><tr><th scope=\"col\">Solusi</th>" + crit.map((c) => '<th scope="col" class="num">' + c.kode + "</th>").join("") + "</tr></thead><tbody>" +
        '<tr><td class="code">Jenis</td>' + crit.map((c) => '<td class="num tiny">' + (c.jenis === "benefit" ? "benefit" : "cost") + "</td>").join("") + "</tr>" +
        '<tr><td class="code">A+ ideal positif</td>' + res.ideal.map((i) => '<td class="num">' + num(i.plus, 4) + "</td>").join("") + "</tr>" +
        '<tr><td class="code">A- ideal negatif</td>' + res.ideal.map((i) => '<td class="num">' + num(i.minus, 4) + "</td>").join("") + "</tr>" +
        "</tbody></table></div>"
      );
    }

    if (tab === "jarak") {
      return (
        '<div class="formula">D<b>+</b>(i) = akar dari jumlah (y<sub>ij</sub> - A+)&sup2; &nbsp;&nbsp; D<b>-</b>(i) = akar dari jumlah (y<sub>ij</sub> - A-)&sup2;</div>' +
        '<div class="table-wrap"><table><caption>Jarak Euclidean setiap alternatif ke dua solusi ideal.</caption>' +
        '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Alternatif</th><th scope="col" class="num">D+</th><th scope="col" class="num">D-</th></tr></thead><tbody>' +
        res.scored.map((s) =>
          "<tr><td class=\"code\">" + esc(s.kode) + "</td><td>" + esc(s.nama) + "</td>" +
          '<td class="num">' + num(s.dPlus, 4) + '</td><td class="num">' + num(s.dMinus, 4) + "</td></tr>").join("") +
        "</tbody></table></div>"
      );
    }

    if (tab === "V") {
      return (
        '<div class="formula">V(i) = D-(i) / (D+(i) + D-(i)). V terbesar menjadi peringkat 1.</div>' +
        rankingTable(res.ranking, { noPick: true })
      );
    }

    const matrix = tab === "X" ? res.X : tab === "R" ? res.R : res.Y;
    const caption =
      tab === "X" ? "Nilai mentah yang dipakai menghitung, hasil konversi kategori ke skala 1 sampai 5." :
      tab === "R" ? "Setiap nilai dibagi pembagi akar jumlah kuadrat kolomnya." :
      "Nilai normalisasi dikali bobot kriteria.";
    const formula =
      tab === "X" ? "X = matriks keputusan" :
      tab === "R" ? "r<sub>ij</sub> = x<sub>ij</sub> / akar( jumlah x<sub>ij</sub>&sup2; )" :
      "y<sub>ij</sub> = w<sub>j</sub> x r<sub>ij</sub>";

    let head = "<thead><tr><th scope=\"col\" class=\"code\">Kode</th><th scope=\"col\">Alternatif</th>";
    crit.forEach((c) => { head += '<th scope="col" class="num">' + c.kode + " <span class=\"tiny\">" + (tab === "X" ? "" : "") + "</span></th>"; });
    head += "</tr></thead>";

    let body = "<tbody>";
    if (tab === "Y") {
      body += '<tr><td class="code">w</td><td class="tiny">bobot</td>' +
        res.weights.map((w) => '<td class="num tiny">' + pct(w) + "</td>").join("") + "</tr>";
    }
    alts.forEach((a, i) => {
      body += "<tr><td class=\"code\">" + esc(a.kode) + "</td><td>" + esc(a.nama) + "</td>";
      matrix[i].forEach((v, j) => {
        body += '<td class="num">' + num(v, tab === "X" ? (model.criteria[j].kode === "C1" ? 0 : 2) : 4) + "</td>";
      });
      body += "</tr>";
    });
    body += "</tbody>";

    let extra = "";
    if (tab === "R") {
      extra = '<p class="tiny" style="margin-top:10px">Cek: jumlah kuadrat setiap kolom = 1 (' +
        res.R[0].map((_, j) => num(res.R.reduce((s, row) => s + row[j] * row[j], 0), 4)).join(" / ") + ").</p>";
    }
    if (tab === "X") {
      extra = '<p class="tiny" style="margin-top:10px">Pembagi akar jumlah kuadrat: ' +
        res.div.map((d) => num(d, 4)).join(" / ") + ".</p>";
    }

    return (
      '<div class="formula">' + formula + "</div>" +
      '<div class="table-wrap"><table><caption>' + caption + "</caption>" + head + body + "</table></div>" + extra
    );
  }

  function viewMatriks(model) {
    return (
      '<div class="view-grid">' +
        '<section class="panel span-12" aria-labelledby="matrix-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Jejak perhitungan</p><h2 class="panel-title" id="matrix-title">Matriks TOPSIS</h2></div>' +
          '<p class="panel-note">Semua tabel dihitung ulang di peramban dari data mentah.</p></div>' +
          '<div class="tabs" role="group" aria-label="Pilih tahap perhitungan">' +
            MATRIX_TABS.map((t) => '<button class="tab" type="button" data-tab="' + t.id + '" aria-pressed="' + (state.tab === t.id) + '">' + esc(t.label) + "</button>").join("") +
          "</div>" +
          matrixTable(model) +
        "</section>" +
        '<section class="panel span-6" aria-labelledby="scale-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Konversi</p><h2 class="panel-title" id="scale-title">Skala kategori</h2></div></div>' +
          '<p class="panel-note">Kriteria kualitatif C3, C4, C5 dikonversi dengan skala berikut sebelum masuk matriks X.</p>' +
          '<div class="detail-list" style="margin-top:10px">' +
            ["sangat baik", "baik", "cukup", "kurang", "sangat kurang"].map((k) => {
              const v = model.scaleMap[k];
              return '<div class="detail-item"><span>' + esc(k.replace(/\b\w/g, (m) => m.toUpperCase())) + " " + scale5(v, true) + '</span><span>' + (v == null ? "-" : v) + "</span></div>";
            }).join("") +
          "</div>" +
        "</section>" +
        '<section class="panel span-6" aria-labelledby="order-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Bahan hitung</p><h2 class="panel-title" id="order-title">Kriteria dan jenisnya</h2></div></div>' +
          '<div class="table-wrap"><table><caption>Arah optimasi memengaruhi penentuan A+ dan A-.</caption>' +
          '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Kriteria</th><th scope="col">Jenis</th><th scope="col" class="num">Bobot</th></tr></thead><tbody>' +
          model.criteria.map((c) =>
            '<tr><td class="code">' + c.kode + "</td><td>" + esc(c.nama) + "</td><td>" +
            (c.jenis === "benefit" ? "Benefit" : "Cost") + '</td><td class="num">' + pct(c.bobot) + "</td></tr>").join("") +
          "</tbody></table></div>" +
        "</section>" +
      "</div>"
    );
  }

  /* ---------------- view: kriteria ---------------- */

  function viewKriteria(model) {
    const sim = state.simWeights;
    const weights = sim || model.criteria.map((c) => c.bobot);
    const preview = topsis(model.criteria, model.alternatives, weights);
    const simActive = !!sim;

    return (
      '<div class="view-grid">' +
        '<section class="panel span-6" aria-labelledby="krit-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Sheet</p><h2 class="panel-title" id="krit-title">Bobot dari spreadsheet</h2></div>' +
          '<p class="panel-note">Jumlah bobot ' + pct(model.criteria.reduce((a, c) => a + c.bobot, 0)) + ".</p></div>" +
          '<div class="table-wrap"><table><caption>Tujuh kriteria dengan jenis dan bobotnya.</caption>' +
          '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Kriteria</th><th scope="col">Jenis</th><th scope="col" class="num">Bobot</th></tr></thead><tbody>' +
          model.criteria.map((c) =>
            '<tr><td class="code">' + c.kode + "</td><td>" + esc(c.nama) + "</td><td>" +
            '<span class="crit-tag" data-jenis="' + c.jenis + '">' + (c.jenis === "benefit" ? "Benefit" : "Cost") + "</span></td>" +
            '<td class="num">' + pct(c.bobot) + "</td></tr>").join("") +
          "</tbody></table></div>" +
          '<p class="tiny" style="margin-top:12px">Cost: harga sewa, jarak ke kampus, jarak ke minimarket. Benefit: fasilitas, keamanan, kebersihan, luas kamar.</p>' +
        "</section>" +

        '<section class="panel span-6" aria-labelledby="sim-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Simulasi</p><h2 class="panel-title" id="sim-title">Ubah bobot untuk uji sensitivitas</h2></div>' +
          '<button class="btn btn-sm" type="button" data-reset-weights' + (simActive ? "" : " disabled") + ">Reset ke bobot sheet</button></div>" +
          '<p class="panel-note">Geser bobot untuk melihat apakah peringkat 1 bertahan. Simulasi tidak mengubah spreadsheet.</p>' +
          '<div class="detail-list" style="margin-top:12px">' +
            model.criteria.map((c, i) => {
              const val = Math.round(weights[i] * 100);
              return '<div class="detail-item" style="grid-template-columns:1fr;gap:4px">' +
                '<label for="w-' + i + '" style="display:flex;justify-content:space-between;gap:10px;font-size:13px">' +
                  "<span>" + esc(c.nama) + " <span class=\"tiny\">" + c.kode + "</span></span>" +
                  '<span data-wval="' + i + '" style="font-weight:600">' + val + "%</span>" +
                "</label>" +
                '<input id="w-' + i + '" type="range" min="0" max="40" step="1" value="' + val + '" data-w="' + i + '">' +
              "</div>";
            }).join("") +
          "</div>" +
          '<p class="form-msg" id="sim-msg" data-tone="' + (simActive ? "ok" : "") + '" role="status">' +
            (simActive ? "Simulasi aktif. Bobot dinormalisasi agar jumlahnya 100%." : "Memakai bobot sheet.") +
          "</p>" +
        "</section>" +

        '<section class="panel span-7" aria-labelledby="preview-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Pratinjau</p><h2 class="panel-title" id="preview-title">Peringkat pada bobot aktif</h2></div></div>' +
          '<div id="weight-preview">' + previewTable(preview, model) + "</div>" +
        "</section>" +
        '<section class="panel span-5" aria-labelledby="read-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Cara membaca</p><h2 class="panel-title" id="read-title">Efek bobot</h2></div></div>' +
          '<div class="prose"><p>Bobot menentukan seberapa besar satu kriteria menarik alternatif ke solusi ideal. Menaikkan bobot kriteria cost membuat kos berharga mahal dan jauh dari kampus turun peringkat.</p>' +
          '<ul><li>Peringkat 1 saat ini: <b>' + esc(model.result.ranking[0].nama) + "</b>.</li>" +
          "<li>Jika hasil simulasi berbeda dari dashboard, itu tanda ranking sensitif terhadap bobot.</li>" +
          "<li>Nilai V tetap dihitung dengan rumus yang sama, hanya w yang berubah.</li></ul></div>" +
        "</section>" +
      "</div>"
    );
  }

  function previewTable(preview, model) {
    const before = new Map(model.result.ranking.map((r) => [r.kode, r.rank]));
    return '<div class="table-wrap"><table><caption>Simulasi dihitung ulang setiap kali slider bergerak.</caption>' +
      '<thead><tr><th scope="col" class="num">Peringkat</th><th scope="col" class="code">Kode</th><th scope="col">Alternatif</th><th scope="col" class="num">V</th><th scope="col">Perubahan</th></tr></thead><tbody>' +
      preview.ranking.map((r) => {
        const old = before.get(r.kode);
        let delta;
        if (old == null) delta = "baru";
        else if (old === r.rank) delta = "tetap";
        else delta = "dari " + old + (r.rank < old ? " naik" : " turun");
        return '<tr class="' + (r.rank === 1 ? "is-top" : "") + '"><td class="num">' + rankBadge(r.rank) + "</td>" +
          '<td class="code">' + esc(r.kode) + "</td><td>" + esc(r.nama) + "</td>" +
          '<td class="num">' + num(r.v, 4) + "</td><td class=\"tiny\">" + delta + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  /* ---------------- view: alternatif ---------------- */

  function viewAlternatif(model) {
    const local = !!model.localMode;
    const editing = state.editing ? model.altByKode.get(state.editing) : null;
    const kodeBaru = nextKode(model.alternatives);
    const val = (x) => esc(x == null ? "" : x);

    const toolbar =
      '<div class="badge-row">' +
        (local ? '<span class="tag" data-tone="amber">Data lokal</span>' : '<span class="tag">Dari sheet</span>') +
        '<button class="btn btn-sm" type="button" data-add>Tambah data</button>' +
        '<button class="btn btn-sm" type="button" data-export' + (model.alternatives.length ? "" : " disabled") + ">Unduh CSV</button>" +
        '<button class="btn btn-sm" type="button" data-reset-local' + (local ? "" : " disabled") + ">Kembali ke data sheet</button>" +
      "</div>";

    const rowsHtml = model.alternatives.length
      ? model.alternatives.map((a) => {
          const edited = local && a.status === "baru" ? '<span class="tag" data-tone="amber">baru</span>'
            : local && a.status === "diubah" ? '<span class="tag">diubah</span>' : "";
          return "<tr" + (state.editing === a.kode ? ' data-selected="true"' : "") + ">" +
            '<td class="code">' + esc(a.kode) + "</td>" +
            "<td>" + esc(a.nama) + " " + edited + "</td>" +
            '<td class="num">' + rupiah(a.harga) + "</td>" +
            '<td class="num">' + num(a.jarakKampus, 1) + " km</td>" +
            '<td><span class="badge-row">' + scale5(a.fasilitas) + '<span class="tiny">' + esc(a.kategori.fasilitas || "") + "</span></span></td>" +
            '<td><span class="badge-row">' + scale5(a.keamanan) + '<span class="tiny">' + esc(a.kategori.keamanan || "") + "</span></span></td>" +
            '<td><span class="badge-row">' + scale5(a.kebersihan) + '<span class="tiny">' + esc(a.kategori.kebersihan || "") + "</span></span></td>" +
            '<td class="num">' + num(a.luas, 0) + " m²</td>" +
            '<td class="num">' + num(a.jarakMinimarket, 1) + " km</td>" +
            '<td><span class="row-actions">' +
              '<button class="link-btn" type="button" data-edit="' + esc(a.kode) + '" aria-label="Ubah data ' + esc(a.nama) + '">Ubah</button>' +
              '<button class="link-btn danger" type="button" data-del="' + esc(a.kode) + '" aria-label="Hapus data ' + esc(a.nama) + '">Hapus</button>' +
            "</span></td></tr>";
        }).join("")
      : '<tr><td colspan="10" class="muted">Belum ada alternatif. Isi formulir di bawah untuk menambahkan data pertama.</td></tr>';

    const catSelect = (id, label, value) =>
      '<div class="field"><label for="' + id + '">' + label + "</label>" +
      '<select id="' + id + '" name="' + id + '" required>' +
        '<option value=""' + (value == null ? " selected" : "") + " disabled>Pilih nilai</option>" +
        [5, 4, 3, 2, 1].map((s) =>
          '<option value="' + s + '"' + (Number(value) === s ? " selected" : "") + ">" + s + " " + KATEGORI[s] + "</option>").join("") +
      "</select></div>";

    return (
      '<div class="view-grid">' +
        '<section class="panel span-12" aria-labelledby="alt-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">' + (local ? "Input lokal" : "Data survei") + '</p>' +
            '<h2 class="panel-title" id="alt-title">Nilai setiap alternatif</h2></div>' + toolbar + "</div>" +
          '<p class="panel-note">' + (local
            ? "Data di bawah berasal dari input Anda dan disimpan di peramban ini. Spreadsheet tidak diubah."
            : "Data di bawah dibaca dari spreadsheet. Tambah atau ubah baris lewat formulir di bawah untuk menguji data sendiri.") + "</p>" +
          '<p class="table-hint">Geser tabel ke samping untuk melihat semua kriteria dan tombol Ubah atau Hapus.</p>' +
          '<div class="table-wrap" style="margin-top:12px"><table><caption>' + model.alternatives.length +
          " kos dengan tujuh kriteria. Kolom C3 sampai C5 memakai skala 1 sampai 5.</caption>" +
          '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Alternatif</th>' +
            '<th scope="col" class="num">Harga / bulan</th><th scope="col" class="num">Jarak kampus</th>' +
            '<th scope="col">Fasilitas</th><th scope="col">Keamanan</th><th scope="col">Kebersihan</th>' +
            '<th scope="col" class="num">Luas</th><th scope="col" class="num">Jarak minimarket</th>' +
            '<th scope="col">Aksi</th></tr></thead><tbody>' + rowsHtml + "</tbody></table></div>" +
        "</section>" +

        '<section class="panel span-7" id="editor" aria-labelledby="form-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">' + (editing ? "Ubah baris" : "Baris baru") + '</p>' +
            '<h2 class="panel-title" id="form-title">' + (editing ? "Ubah " + esc(editing.kode) : "Tambah data mentah") + "</h2></div>" +
            (editing ? '<span class="rank-badge">' + esc(editing.kode) + "</span>" : "") +
          "</div>" +
          '<form id="alt-form" novalidate>' +
            '<div class="form-grid">' +
              '<div class="field"><label for="f-kode">Kode</label>' +
                '<input id="f-kode" type="text" value="' + (editing ? esc(editing.kode) : esc(kodeBaru)) + '" readonly aria-describedby="f-kode-hint">' +
                '<p class="field-hint" id="f-kode-hint">Dibuat otomatis, tidak bisa diubah.</p></div>' +
              '<div class="field"><label for="f-nama">Nama kos</label>' +
                '<input id="f-nama" name="nama" type="text" maxlength="60" required value="' + (editing ? esc(editing.nama) : "") + '" placeholder="Contoh: Kos Melati"></div>' +
              '<div class="field"><label for="f-harga">Harga sewa per bulan (Rp)</label>' +
                '<input id="f-harga" name="harga" type="text" inputmode="numeric" required value="' + (editing ? esc(editing.harga) : "") + '" placeholder="650000"></div>' +
              '<div class="field"><label for="f-jarak">Jarak ke kampus (km)</label>' +
                '<input id="f-jarak" name="jarakKampus" type="text" inputmode="decimal" required value="' + (editing ? esc(editing.jarakKampus) : "") + '" placeholder="0,5"></div>' +
              '<div class="field"><label for="f-luas">Luas kamar (m²)</label>' +
                '<input id="f-luas" name="luas" type="text" inputmode="decimal" required value="' + (editing ? esc(editing.luas) : "") + '" placeholder="12"></div>' +
              '<div class="field"><label for="f-minimarket">Jarak ke minimarket (km)</label>' +
                '<input id="f-minimarket" name="jarakMinimarket" type="text" inputmode="decimal" required value="' + (editing ? esc(editing.jarakMinimarket) : "") + '" placeholder="0,3"></div>' +
              catSelect("f-fasilitas", "Fasilitas (1 sampai 5)", editing ? editing.fasilitas : null) +
              catSelect("f-keamanan", "Keamanan (1 sampai 5)", editing ? editing.keamanan : null) +
              catSelect("f-kebersihan", "Kebersihan (1 sampai 5)", editing ? editing.kebersihan : null) +
            "</div>" +
            '<p class="form-msg" id="alt-msg" role="alert"></p>' +
            '<div class="state-actions">' +
              '<button class="btn btn-primary btn-sm" type="submit">' + (editing ? "Simpan perubahan" : "Tambahkan data") + "</button>" +
              (editing ? '<button class="btn btn-sm" type="button" data-cancel-edit>Batal</button>' : "") +
            "</div>" +
          "</form>" +
        "</section>" +

        '<section class="panel span-5" aria-labelledby="local-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Cara kerja</p><h2 class="panel-title" id="local-title">Data Anda, bukan sheet</h2></div></div>' +
          '<div class="prose"><ul>' +
            "<li>Baris baru langsung masuk hitungan TOPSIS dan peringkat diperbarui.</li>" +
            "<li>Data disimpan di peramban ini, jadi tetap ada setelah halaman ditutup.</li>" +
            "<li>Spreadsheet sumber tidak diubah. Untuk memindahkan data, pakai Unduh CSV lalu tempel ke sheet.</li>" +
            "<li>Tombol Kembali ke data sheet membuang input lokal dan memakai angka sheet lagi.</li>" +
            "<li>Nilai kategori mengikuti skala sheet: 5 Sangat Baik sampai 1 Sangat Kurang.</li>" +
          "</ul></div>" +
          (local ? '<p class="tiny" style="margin-top:12px">Kode ' + esc(model.alternatives.map((a) => a.kode).join(", ")) + " aktif saat ini.</p>" : "") +
        "</section>" +
      "</div>"
    );
  }

  /* ---------------- view: metode ---------------- */

  const STEPS = [
    { t: "Matriks keputusan", d: "Kumpulkan nilai setiap alternatif pada tujuh kriteria. Kategori Sangat Baik sampai Sangat Kurang dikonversi ke 5 sampai 1." },
    { t: "Normalisasi", d: "Bagi tiap nilai dengan akar jumlah kuadrat kolomnya sehingga satuan rupiah, kilometer, dan m² bisa dibandingkan." },
    { t: "Pembobotan", d: "Kalikan nilai ternormalisasi dengan bobot kriteria. Total bobot pada sheet 100%." },
    { t: "Solusi ideal", d: "A+ berisi nilai terbaik per kriteria, A- berisi nilai terburuk. Untuk kriteria cost, terbaik berarti nilai terkecil." },
    { t: "Jarak Euclidean", d: "Hitung D+ ke A+ dan D- ke A- untuk setiap alternatif." },
    { t: "Nilai preferensi", d: "V = D- / (D+ + D-). Alternatif dengan V terbesar menempati peringkat 1." }
  ];

  function viewMetode(model) {
    const checks = model.validation;
    const passed = checks.filter((c) => c.ok).length;
    const vRows = model.result.ranking.map((r) => {
      const sheet = model.sheetV.get(r.kode);
      return {
        kode: r.kode,
        nama: r.nama,
        hitung: r.v,
        sheet: sheet ? sheet.v : null,
        diff: sheet ? Math.abs(r.v - sheet.v) : null
      };
    });

    return (
      '<div class="view-grid">' +
        '<section class="panel span-7" aria-labelledby="steps-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Prosedur</p><h2 class="panel-title" id="steps-title">Enam langkah TOPSIS</h2></div>' +
          '<p class="panel-note">Semua langkah dijalankan ulang saat data diperbarui.</p></div>' +
          '<div class="steps">' + STEPS.map((s, i) =>
            '<div class="step"><span class="step-num">' + (i + 1) + "</span><div><h4>" + esc(s.t) + "</h4><p>" + esc(s.d) + "</p></div></div>").join("") +
          "</div>" +
        "</section>" +

        '<section class="panel span-5" aria-labelledby="valid-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Pemeriksaan</p><h2 class="panel-title" id="valid-title">Validasi hasil</h2></div>' +
          '<p class="panel-note">' + passed + " dari " + checks.length + " lolos.</p></div>" +
          '<ul class="check-list" style="list-style:none">' + checks.map((c) =>
            '<li><span class="check-mark" data-fail="' + (!c.ok) + '" aria-hidden="true">' + (c.ok ? "OK" : "X") + "</span>" +
            "<span>" + esc(c.label) + '<br><span class="tiny">' + esc(c.detail) + "</span></span></li>").join("") +
          "</ul>" +
          '<p class="tiny" style="margin-top:14px">Pemeriksaan membandingkan hasil hitung peramban dengan blok B dan G pada spreadsheet.</p>' +
        "</section>" +

        '<section class="panel span-12" aria-labelledby="cmp-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Silang</p><h2 class="panel-title" id="cmp-title">Nilai V: hitung ulang vs sheet</h2></div></div>' +
          '<div class="table-wrap"><table><caption>Selisih di bawah 0,0006 berarti pembulatan empat desimal menghasilkan angka yang sama.</caption>' +
          '<thead><tr><th scope="col" class="code">Kode</th><th scope="col">Alternatif</th><th scope="col" class="num">V hitung</th><th scope="col" class="num">V sheet</th><th scope="col" class="num">Selisih</th><th scope="col">Status</th></tr></thead><tbody>' +
          vRows.map((r) =>
            '<tr><td class="code">' + esc(r.kode) + "</td><td>" + esc(r.nama) + "</td>" +
            '<td class="num">' + num(r.hitung, 4) + "</td>" +
            '<td class="num">' + (r.sheet == null ? "-" : num(r.sheet, 4)) + "</td>" +
            '<td class="num">' + (r.diff == null ? "-" : num(r.diff, 4)) + "</td>" +
            "<td>" + (r.diff == null ? '<span class="tag">tidak ada di sheet</span>' : r.diff < 0.0006 ? '<span class="tag" data-tone="amber">sama</span>' : '<span class="tag">beda</span>') + "</td></tr>").join("") +
          "</tbody></table></div>" +
        "</section>" +
      "</div>"
    );
  }

  /* ---------------- view: sumber ---------------- */

  function viewSumber(model) {
    const sourceLabel = {
      server: "Server lokal membaca sheet",
      gviz: "Langsung dari Google (gviz)",
      export: "Langsung dari Google (export CSV)",
      manual: "Impor manual",
      cache: "Cache lokal peramban"
    }[state.source] || "Belum diketahui";
    const interval = store.get(LS.interval) || "0";
    const standalone = location.protocol === "file:";

    return (
      '<div class="view-grid">' +
        '<section class="panel span-6" aria-labelledby="src-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Koneksi</p><h2 class="panel-title" id="src-title">Status sumber data</h2></div>' +
          '<span class="status-chip" data-state="' + (state.status === "live" ? "live" : state.status === "error" ? "error" : "loading") + '"><span class="dot" aria-hidden="true"></span>' + esc(statusText.textContent) + "</span></div>" +
          '<div class="detail-list" style="margin-top:0">' +
            '<div class="detail-item"><span>Sumber aktif</span><span>' + esc(sourceLabel) + "</span></div>" +
            '<div class="detail-item"><span>Sinkron terakhir</span><span>' + (state.fetchedAt ? esc(stamp(state.fetchedAt)) : "-") + "</span></div>" +
            '<div class="detail-item"><span>Alternatif terbaca</span><span>' + model.alternatives.length + "</span></div>" +
            '<div class="detail-item"><span>Sumber baris</span><span>' + (model.localMode ? "Input lokal, sheet tidak diubah" : "Blok data mentah sheet") + "</span></div>" +
            '<div class="detail-item"><span>Kriteria terbaca</span><span>' + model.criteria.length + "</span></div>" +
            '<div class="detail-item"><span>Mode aplikasi</span><span>' + (standalone ? "File statis (tanpa server)" : "Server lokal dengan proxy") + "</span></div>" +
          "</div>" +
          (state.error ? '<p class="form-msg" data-tone="error" style="margin-top:12px">Sinkron terakhir gagal: ' + esc(state.error.message) + "</p>" : "") +
          '<div class="state-actions">' +
            '<button class="btn btn-primary btn-sm" type="button" data-sync>Sinkron sekarang</button>' +
            '<a class="btn btn-sm" href="' + SHEET_EDIT + '" target="_blank" rel="noopener">Buka spreadsheet</a>' +
          "</div>" +
        "</section>" +

        '<section class="panel span-6" aria-labelledby="refresh-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Jadwal</p><h2 class="panel-title" id="refresh-title">Sinkron otomatis</h2></div></div>' +
          '<div class="field" style="max-width:260px">' +
            '<label for="interval">Selang pembaruan</label>' +
            '<select id="interval" class="btn" style="width:100%">' +
              '<option value="0"' + (interval === "0" ? " selected" : "") + ">Manual saja</option>" +
              '<option value="300000"' + (interval === "300000" ? " selected" : "") + ">Setiap 5 menit</option>" +
              '<option value="900000"' + (interval === "900000" ? " selected" : "") + ">Setiap 15 menit</option>" +
            "</select>" +
            '<p class="field-hint">Pembaruan otomatis memakai sumber yang sama dengan tombol sinkron. Preferensi disimpan di peramban ini.</p>' +
          "</div>" +
          '<p class="panel-note" style="margin-top:14px">Spreadsheet harus bisa dibaca tanpa login. Bila sudah dipublikasikan atau dibagikan dengan tautan, pembacaan CSV berjalan langsung.</p>' +
        "</section>" +

        '<section class="panel span-7" aria-labelledby="import-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Cadangan</p><h2 class="panel-title" id="import-title">Impor CSV manual</h2></div></div>' +
          '<p class="panel-note">Tempel isi CSV dari spreadsheet (File, Download, CSV) bila koneksi langsung diblokir.</p>' +
          '<form id="import-form" class="field" style="margin-top:12px">' +
            '<label for="csv-input">Isi CSV</label>' +
            '<textarea id="csv-input" spellcheck="false" placeholder="Kode,Alternatif,..."></textarea>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">' +
              '<button class="btn btn-primary btn-sm" type="submit">Gunakan data ini</button>' +
              '<button class="btn btn-sm" type="button" data-file>Pilih file CSV</button>' +
              '<input type="file" id="csv-file" accept=".csv,text/csv" aria-label="Pilih file CSV" hidden>' +
            "</div>" +
            '<p class="form-msg" id="import-msg" role="status"></p>' +
          "</form>" +
        "</section>" +

        '<section class="panel span-5" aria-labelledby="note-title">' +
          '<div class="panel-head"><div><p class="panel-kicker">Catatan</p><h2 class="panel-title" id="note-title">Batas data ini</h2></div></div>' +
          '<div class="prose"><ul>' +
            "<li>Nilai pada sheet ditandai penyusun sebagai data ilustrasi latihan, bukan hasil survei lapangan.</li>" +
            "<li>Dashboard menghitung ulang TOPSIS dari data mentah, jadi perubahan di sheet ikut terbaca setelah sinkron.</li>" +
            "<li>Bobot pada halaman kriteria adalah simulasi lokal dan tidak menulis ke spreadsheet.</li>" +
            "<li>Baris yang Anda tambahkan di Data alternatif disimpan di peramban ini, bukan di spreadsheet.</li>" +
            "<li>Angka rupiah, kilometer, dan luas mengikuti format sel di sheet.</li>" +
          "</ul></div>" +
        "</section>" +
      "</div>"
    );
  }

  /* ---------------- router ---------------- */

  function render() {
    if (!state.model) {
      if (state.status === "error") return;
      renderLoading();
      return;
    }
    const model = state.model;
    viewEl.setAttribute("aria-busy", "false");
    if (!model.alternatives.length && state.view !== "sumber" && state.view !== "alternatif") {
      viewEl.innerHTML =
        emptyState(
          "Belum ada alternatif",
          "Spreadsheet terbaca, tetapi tidak ada baris alternatif lengkap. Tambahkan data sendiri lewat menu Data alternatif, atau isi baris A1 dan seterusnya di sheet lalu sinkron lagi.",
          '<div class="state-actions">' +
            '<a class="btn btn-primary btn-sm" href="#alternatif" data-goto="alternatif">Tambah data sendiri</a>' +
            '<button class="btn btn-sm" type="button" data-sync>Sinkron ulang</button>' +
            '<a class="btn btn-sm" href="' + SHEET_EDIT + '" target="_blank" rel="noopener">Buka spreadsheet</a>' +
          "</div>"
        );
      return;
    }
    let html = "";
    if (state.view === "perankingan") html = viewPerankingan(model);
    else if (state.view === "matriks") html = viewMatriks(model);
    else if (state.view === "kriteria") html = viewKriteria(model);
    else if (state.view === "alternatif") html = viewAlternatif(model);
    else if (state.view === "metode") html = viewMetode(model);
    else if (state.view === "sumber") html = viewSumber(model);
    else html = viewRingkasan(model);
    viewEl.innerHTML = html;
    mountCharts();
    if (state.error) {
      viewEl.insertAdjacentHTML("afterbegin",
        '<div class="state" data-tone="error" role="alert" style="margin-bottom:16px"><h2>Memakai cache</h2>' +
        "<p>Sheet tidak terjangkau (" + esc(state.error.message) + "). Angka di bawah berasal dari salinan lokal " +
        (state.fetchedAt ? esc(stamp(state.fetchedAt)) : "") + ".</p>" +
        '<div class="state-actions"><button class="btn btn-primary btn-sm" type="button" data-retry>Coba sinkron lagi</button>' +
        '<a class="btn btn-sm" href="#sumber" data-goto="sumber">Impor CSV</a></div></div>');
    }
  }

  function mountCharts() {
    if (!state.model) return;
    viewEl.querySelectorAll("[data-chart]").forEach((mount) => {
      const w = chartWidth(mount);
      mount.innerHTML = mount.dataset.chart === "bar"
        ? barChart(state.model.result.ranking, w)
        : scatter(state.model.result.ranking, w);
    });
  }

  function setView(name, opts) {
    const next = VIEWS[name] ? name : "ringkasan";
    state.view = next;
    if (next !== "alternatif") state.editing = null;
    const meta = VIEWS[next];
    titleEl.textContent = meta.title;
    subEl.textContent = meta.sub;
    document.title = meta.title + " | SPK Pemilihan Kos TOPSIS";
    nav.querySelectorAll(".nav-link").forEach((a) => {
      const on = a.dataset.target === next;
      a.setAttribute("aria-current", on ? "true" : "false");
    });
    render();
    if (!opts || !opts.noScroll) {
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
      document.getElementById("main").focus({ preventScroll: true });
    }
  }

  function handleHash() {
    const name = (location.hash || "#ringkasan").replace("#", "");
    setView(name);
  }

  /* ---------------- toast ---------------- */

  let toastTimer = null;
  function toast(msg, tone) {
    toastEl.textContent = msg;
    toastEl.dataset.tone = tone === "error" ? "error" : "ok";
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4200);
  }

  /* ---------------- interaksi ---------------- */

  viewEl.addEventListener("click", (e) => {
    const retry = e.target.closest("[data-retry]");
    if (retry) { load(); return; }
    const tab = e.target.closest("[data-tab]");
    if (tab) { state.tab = tab.dataset.tab; render(); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      state.selected = pick.dataset.pick;
      if (state.view !== "perankingan") {
        location.hash = "#perankingan";
        return;
      }
      render();
      const next = viewEl.querySelector('[data-pick="' + state.selected + '"]');
      if (next) next.focus();
      return;
    }
    if (e.target.closest("[data-reset-weights]")) {
      state.simWeights = null;
      render();
      toast("Bobot dikembalikan ke nilai sheet.");
      return;
    }
    if (e.target.closest("[data-sync]")) { load(); }
  });

  viewEl.addEventListener("input", (e) => {
    const slider = e.target.closest("[data-w]");
    if (!slider) return;
    const i = Number(slider.dataset.w);
    if (!state.simWeights) state.simWeights = state.model.criteria.map((c) => c.bobot);
    state.simWeights[i] = Number(slider.value) / 100;
    const label = viewEl.querySelector('[data-wval="' + i + '"]');
    if (label) label.textContent = slider.value + "%";
    const preview = viewEl.querySelector("#weight-preview");
    const msg = viewEl.querySelector("#sim-msg");
    if (preview) preview.innerHTML = previewTable(topsis(state.model.criteria, state.model.alternatives, state.simWeights), state.model);
    if (msg) {
      msg.dataset.tone = "ok";
      msg.textContent = "Simulasi aktif. Bobot dinormalisasi agar jumlahnya 100%.";
    }
  });

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const desimal = (v) => String(v).replace(".", ",");

  function exportCsv(model) {
    const head = ["Kode", "Alternatif", "C1 Harga Sewa (Rp/bulan)", "C2 Jarak ke Kampus (km)",
      "C3 Fasilitas", "C4 Keamanan", "C5 Kebersihan", "C6 Luas Kamar (m2)", "C7 Jarak ke Minimarket (km)"];
    const lines = [head].concat(model.alternatives.map((a) => [
      a.kode, a.nama, rupiah(a.harga), desimal(a.jarakKampus),
      KATEGORI[a.fasilitas] || "", KATEGORI[a.keamanan] || "", KATEGORI[a.kebersihan] || "",
      desimal(a.luas) + " m²", desimal(a.jarakMinimarket)
    ]));
    const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "data-kos-topsis.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("CSV diunduh. Tempel isinya ke sheet bila perlu.");
  }

  function readAltForm(form) {
    const field = (id) => form.querySelector("#" + id);
    const nama = clean(field("f-nama").value);
    const harga = parseNum(field("f-harga").value);
    const jarakKampus = parseNum(field("f-jarak").value);
    const luas = parseNum(field("f-luas").value);
    const jarakMinimarket = parseNum(field("f-minimarket").value);
    const fasilitas = Number(field("f-fasilitas").value);
    const keamanan = Number(field("f-keamanan").value);
    const kebersihan = Number(field("f-kebersihan").value);
    const errors = [];

    if (nama.length < 2) errors.push({ id: "f-nama", msg: "Nama kos minimal 2 karakter." });
    if (harga == null || harga < 50000 || harga > 20000000) {
      errors.push({ id: "f-harga", msg: "Harga sewa harus antara Rp 50.000 dan Rp 20.000.000." });
    }
    if (jarakKampus == null || jarakKampus < 0 || jarakKampus > 50) {
      errors.push({ id: "f-jarak", msg: "Jarak ke kampus harus 0 sampai 50 km." });
    }
    if (luas == null || luas < 4 || luas > 100) {
      errors.push({ id: "f-luas", msg: "Luas kamar harus 4 sampai 100 m²." });
    }
    if (jarakMinimarket == null || jarakMinimarket < 0 || jarakMinimarket > 50) {
      errors.push({ id: "f-minimarket", msg: "Jarak ke minimarket harus 0 sampai 50 km." });
    }
    [["f-fasilitas", fasilitas, "Fasilitas"], ["f-keamanan", keamanan, "Keamanan"], ["f-kebersihan", kebersihan, "Kebersihan"]]
      .forEach(([id, value, label]) => {
        if (!(value >= 1 && value <= 5)) errors.push({ id, msg: label + " harus dipilih 1 sampai 5." });
      });

    return {
      values: { nama, harga, jarakKampus, luas, jarakMinimarket, fasilitas, keamanan, kebersihan },
      errors
    };
  }

  function commitLocal(next) {
    state.model = next;
    persistLocal(next);
    setStatus("local", "Data lokal");
    render();
  }

  function resetLocal() {
    store.remove(LS.local);
    state.model = state.baseModel;
    state.editing = null;
    restoreSourceStatus();
    render();
  }

  viewEl.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) {
      state.editing = null;
      render();
      const editor = document.getElementById("editor");
      const field = document.getElementById("f-nama");
      if (editor) editor.scrollIntoView({ block: "center" });
      if (field) field.focus();
      return;
    }

    const edit = e.target.closest("[data-edit]");
    if (edit) {
      state.editing = edit.dataset.edit;
      render();
      const field = document.getElementById("f-nama");
      const editor = document.getElementById("editor");
      if (editor) editor.scrollIntoView({ block: "center" });
      if (field) field.focus();
      return;
    }

    if (e.target.closest("[data-cancel-edit]")) {
      state.editing = null;
      render();
      const addBtn = viewEl.querySelector("[data-add]");
      if (addBtn) addBtn.focus();
      return;
    }

    const del = e.target.closest("[data-del]");
    if (del) {
      const kode = del.dataset.del;
      const alt = state.model.altByKode.get(kode);
      if (!alt) return;
      if (!window.confirm("Hapus " + alt.nama + " (" + kode + ")? Data hanya dihapus dari input lokal.")) return;
      const rows = state.model.alternatives.filter((a) => a.kode !== kode);
      state.editing = null;
      if (!rows.length) {
        resetLocal();
        toast("Baris terakhir dihapus, kembali ke data sheet.");
        return;
      }
      commitLocal(recompute(state.model, rows));
      toast("Data " + kode + " dihapus dari data lokal.");
      return;
    }

    if (e.target.closest("[data-reset-local]")) {
      if (!state.model.localMode) return;
      if (!window.confirm("Buang semua data lokal dan pakai data sheet lagi?")) return;
      resetLocal();
      toast("Data lokal dibuang. Dashboard memakai data sheet.");
      return;
    }

    if (e.target.closest("[data-export]")) {
      if (state.model.alternatives.length) exportCsv(state.model);
      return;
    }

  });

  viewEl.addEventListener("submit", (e) => {
    const altForm = e.target.closest("#alt-form");
    if (altForm) {
      e.preventDefault();
      const msg = altForm.querySelector("#alt-msg");
      const { values, errors } = readAltForm(altForm);
      altForm.querySelectorAll("input, select").forEach((el) => el.removeAttribute("aria-invalid"));
      if (errors.length) {
        errors.forEach((err) => {
          const el = altForm.querySelector("#" + err.id);
          if (el) el.setAttribute("aria-invalid", "true");
        });
        msg.dataset.tone = "error";
        msg.textContent = errors.map((err) => err.msg).join(" ");
        const first = altForm.querySelector('[aria-invalid="true"]');
        if (first) first.focus();
        return;
      }

      const current = state.model.alternatives;
      let rows;
      if (state.editing) {
        rows = current.map((a) => a.kode === state.editing
          ? Object.assign({}, a, values, { status: a.status === "baru" ? "baru" : "diubah" })
          : a);
      } else {
        rows = current.concat([Object.assign({}, values, { kode: nextKode(current), status: "baru" })]);
      }

      const kode = state.editing || rows[rows.length - 1].kode;
      const wasEditing = !!state.editing;
      state.editing = null;
      commitLocal(recompute(state.model, rows));
      toast(wasEditing ? "Data " + kode + " diperbarui." : "Data " + kode + " ditambahkan.");
      const nextBtn = viewEl.querySelector('[data-edit="' + kode + '"]');
      if (nextBtn) nextBtn.focus();
      return;
    }

    const form = e.target.closest("#import-form");
    if (!form) return;
    e.preventDefault();
    const ta = form.querySelector("#csv-input");
    const msg = form.querySelector("#import-msg");
    const text = ta.value.trim();
    if (!text) {
      msg.dataset.tone = "error";
      msg.textContent = "Isi CSV masih kosong.";
      ta.focus();
      return;
    }
    try {
      const base = loadModel(text);
      state.simWeights = null;
      state.selected = null;
      state.editing = null;
      state.error = null;
      state.source = "manual";
      state.fetchedAt = new Date();
      store.set(LS.cache, text);
      store.set(LS.cacheAt, String(state.fetchedAt.getTime()));
      state.model = prepareModel(base);
      setStatus(state.model.localMode ? "local" : "manual", state.model.localMode ? "Data lokal" : "Impor manual");
      render();
      updateMeta();
      const fresh = document.getElementById("import-msg");
      if (fresh) {
        fresh.dataset.tone = "ok";
        fresh.textContent = "Data dipakai: " + state.model.alternatives.length + " alternatif, " + state.model.criteria.length + " kriteria.";
      }
      toast("Data impor manual dipakai.");
    } catch (err) {
      msg.dataset.tone = "error";
      msg.textContent = "CSV tidak dikenali: " + err.message;
    }
  });

  viewEl.addEventListener("change", (e) => {
    if (e.target.id !== "csv-file") return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ta = document.getElementById("csv-input");
      if (ta) { ta.value = String(reader.result || ""); ta.focus(); }
      toast("File dimuat ke kotak CSV. Tekan Gunakan data ini.");
    };
    reader.readAsText(file);
  });

  viewEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-file]")) {
      const input = document.getElementById("csv-file");
      if (input) input.click();
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id !== "interval") return;
    const val = e.target.value;
    store.set(LS.interval, val);
    scheduleRefresh();
    toast(val === "0" ? "Sinkron otomatis dimatikan." : "Sinkron otomatis aktif.");
  });

  nav.addEventListener("click", (e) => {
    const link = e.target.closest(".nav-link");
    if (!link) return;
    if (window.innerWidth <= 900) closeSidebar();
  });

  function scheduleRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    const val = Number(store.get(LS.interval) || "0");
    if (!val) return;
    state.refreshTimer = setInterval(() => load({ silent: true }), val);
  }

  /* ---------------- sidebar mobile ---------------- */

  function openSidebar() {
    sidebar.dataset.open = "true";
    scrim.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    menuBtn.setAttribute("aria-label", "Tutup navigasi");
    const first = sidebar.querySelector(".nav-link");
    if (first) first.focus();
  }

  function closeSidebar() {
    sidebar.dataset.open = "false";
    scrim.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.setAttribute("aria-label", "Buka navigasi");
  }

  menuBtn.addEventListener("click", () => {
    if (sidebar.dataset.open === "true") closeSidebar();
    else openSidebar();
  });
  scrim.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebar.dataset.open === "true") {
      closeSidebar();
      menuBtn.focus();
    }
  });

  /* ---------------- tema ---------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeBtn.textContent = theme === "dark" ? "Mode terang" : "Mode gelap";
    themeBtn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    store.set(LS.theme, theme);
  }

  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    toast(next === "dark" ? "Mode gelap aktif." : "Mode terang aktif.");
  });

  syncBtn.addEventListener("click", () => load());

  /* ---------------- mulai ---------------- */

  const savedTheme = store.get(LS.theme);
  applyTheme(savedTheme === "dark" ? "dark" : "light");

  window.addEventListener("hashchange", handleHash);
  let resizeFrame = null;
  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = null; mountCharts(); });
  });
  handleHash();
  scheduleRefresh();
  updateMeta();
  load();
})();
