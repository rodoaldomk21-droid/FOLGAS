// Estratégia: tenta a internet primeiro (sempre pega a versão nova) e usa o cache só se estiver offline.
// Ao alterar qualquer arquivo do app, mude o número da versão abaixo.
const VERSAO = 'folga-v10';
const ARQUIVOS = ['./', 'index.html', 'manifest.json', 'app.css', 'app.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => Promise.all(ARQUIVOS.map(a => c.add(new Request(a, { cache: 'reload' }))))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(r => { const copia = r.clone(); caches.open(VERSAO).then(c => c.put(e.request, copia)); return r; })
      .catch(() => caches.match(e.request))
  );
});
