#!/usr/bin/env node
/* Server statis + proxy Google Sheets untuk dashboard SPK TOPSIS.
   Tanpa dependency npm. Jalankan: node server.js
   Lalu buka http://localhost:4321 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4321);
const SHEET_ID = "140zFrdtspotuxfE3mTRzh7XldkYRHgWWWkzEJ7KlEbE";
/* Urutan penting: export CSV memuat seluruh kolom. CSV dari gviz menghilangkan
   beberapa sel gabungan pada blok kriteria, jadi dipakai sebagai cadangan saja. */
const SHEET_URLS = [
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`,
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`
];
const CACHE_MS = 30 * 1000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8"
};

let cache = { at: 0, text: null };

async function readSheet() {
  if (cache.text && Date.now() - cache.at < CACHE_MS) return cache.text;
  let lastError = null;
  for (const url of SHEET_URLS) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim()) throw new Error("Balasan kosong");
      if (/<html/i.test(text.slice(0, 200))) throw new Error("Balasan HTML, bukan CSV");
      cache = { at: Date.now(), text };
      return text;
    } catch (err) {
      lastError = err;
    }
  }
  if (cache.text) return cache.text;
  throw lastError || new Error("Gagal mengambil sheet");
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  }, headers || {}));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return send(res, 400, "Bad request", { "Content-Type": "text/plain; charset=utf-8" });
  }

  if (url.pathname === "/api/sheet") {
    try {
      const text = await readSheet();
      return send(res, 200, text, {
        "Content-Type": "text/csv; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Sheet-Cached": cache.at ? String(Date.now() - cache.at < CACHE_MS) : "false"
      });
    } catch (err) {
      return send(res, 502, JSON.stringify({ error: String(err.message || err) }), {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
    }
  }

  if (url.pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true, sheet: SHEET_ID }), {
      "Content-Type": "application/json; charset=utf-8"
    });
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  const filePath = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    return send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        return send(res, 404, "Halaman tidak ditemukan", { "Content-Type": "text/plain; charset=utf-8" });
      }
      return send(res, 500, "Gagal membaca file", { "Content-Type": "text/plain; charset=utf-8" });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard SPK TOPSIS berjalan di http://localhost:${PORT}`);
  console.log(`Proxy spreadsheet: http://localhost:${PORT}/api/sheet`);
});
