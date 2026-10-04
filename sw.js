// Guarda os arquivos no iPhone para o app abrir sem internet.
// Ao alterar qualquer arquivo, mude o número da versão abaixo.
const VERSAO = 'folga-v1';
const ARQUIVOS = ['./', 'index.html', 'manifest.json', 'css/app.css', 'js/app.js', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

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
