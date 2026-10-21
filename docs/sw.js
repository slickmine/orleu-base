// Сервис-воркер нужен для установки приложения на телефон/ПК.
// Данные всегда берутся из базы Supabase; кэш — только запасной вариант для оболочки сайта.
const CACHE = 'orleu-shell-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'data.js', 'config.js', 'logo.png', 'icon-192.png',
  'vendor/supabase.js', 'vendor/qrcode.js', 'vendor/html5-qrcode.min.js', 'vendor/xlsx.full.min.js']
  .map(p => new URL(p, self.registration.scope).pathname);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // сначала сеть со сверкой версии (no-cache: браузер не отдаёт устаревший файл из своего кэша), без сети — кэш
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match(SHELL[0]) : Response.error())))
  );
});
