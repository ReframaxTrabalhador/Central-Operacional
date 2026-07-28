/* Service Worker — REFRAMAX Central Operacional (PWA)
   Publique este arquivo no MESMO diretório do index/central.html.

   Estratégia:
   - HTML e navegações: REDE PRIMEIRO. O usuário sempre recebe a versão publicada
     mais recente ao abrir o app (sem ficar preso em versão antiga). Se estiver
     offline, cai para a última versão em cache.
   - Firebase/Google: nunca intercepta (dados sempre pela rede, sempre atuais).
   - Outros estáticos (fontes, libs): cache primeiro, atualizando em segundo plano.
*/
const CACHE = 'central-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Nunca intercepta Firebase/Google/APIs — sempre rede, dados sempre atuais.
  if (/firestore|googleapis|gstatic|firebaseio|identitytoolkit|google\.com|firebaseinstallations/.test(url.hostname)) {
    return;
  }

  const isHTML = req.mode === 'navigate'
    || (req.destination === 'document')
    || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // REDE PRIMEIRO para o app: garante que o usuário receba a versão nova.
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200 && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./')))
    );
    return;
  }

  // Demais estáticos: cache primeiro, atualizando em segundo plano.
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.status === 200 && url.origin === self.location.origin) {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    )
  );
});
