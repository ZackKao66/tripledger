// 旅帳 Service Worker：讓 APP 可以離線開啟
const VERSION = "tripledger-v2";
const APP_SHELL = ["./", "index.html", "firebase-config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Firebase 登入與資料庫連線不經過快取
  if (/googleapis\.com|firebaseapp\.com|accounts\.google\.com|securetoken/.test(url.host)) return;
  // 匯率與 APP 本體：優先抓最新，沒網路時用快取
  if (url.origin === location.origin) {
    e.respondWith(fetch(req.url, { cache: "no-cache" }).then(res => {
      const copy = res.clone(); if (res.ok) caches.open(VERSION).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  // 字型、Firebase 程式庫等外部資源：先用快取，背景更新
  if (/gstatic\.com|fonts\.googleapis\.com|cdnjs\.cloudflare\.com/.test(url.host)) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
