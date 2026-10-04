// Guarda os arquivos no iPhone para o app abrir sem internet.
// Ao alterar qualquer arquivo, mude o número da versão abaixo.
const VERSAO = 'folga-v2';
const ARQUIVOS = ['./', 'index.html', 'manifest.json', 'app.css', 'app.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
