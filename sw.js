/* ============================================================================
   Service Worker — REFRAMAX Central Operacional (PWA)
   Versão do app: central_30 (RH/Férias · Escalas · Hierarquia de equipes)

   ONDE PUBLICAR
   Este arquivo precisa ficar no MESMO diretório do HTML do app (o mesmo lugar
   onde está o central_30.html / index.html). No GitHub Pages, se o app abre em
   https://usuario.github.io/repo/, o sw.js tem que estar em .../repo/sw.js.

   IMPORTANTE A CADA PUBLICAÇÃO
   Suba o número em CACHE (central-v4 -> central-v5 -> ...). É isso que apaga o
   cache antigo e força todo mundo a receber a versão nova. Se o número não
   mudar, o navegador pode continuar servindo arquivos estáticos antigos.

   ESTRATÉGIA
   - HTML e navegações: REDE PRIMEIRO, ignorando o cache HTTP do navegador.
     O usuário sempre abre a versão publicada mais recente. Sem rede, cai para
     a última versão guardada.
   - Firebase / Firestore / Auth: NUNCA intercepta. Dado é dado — sempre rede.
   - Bibliotecas e fontes (cdnjs, Google Fonts, SDK do Firebase no gstatic):
     cache primeiro, atualizando em segundo plano. São arquivos versionados,
     então guardar é seguro e o app abre rápido (e funciona offline).
   ========================================================================== */

const CACHE = 'central-v4';

/* Casca mínima pré-carregada na instalação: garante que o app abra offline
   já no primeiro uso. Falha aqui não pode impedir a instalação do SW. */
const PRECACHE = ['./'];

/* ---------------------------------------------------------------------------
   Hosts que NUNCA podem ser interceptados: são chamadas de DADOS (leitura,
   escrita, login, token). Qualquer cache aqui devolveria informação velha.
   --------------------------------------------------------------------------- */
function ehChamadaDeDados(url) {
  const h = url.hostname;
  if (/\.firebaseio\.com$/.test(h)) return true;
  if (/(^|\.)firebaseinstallations\.googleapis\.com$/.test(h)) return true;
  if (/(^|\.)identitytoolkit\.googleapis\.com$/.test(h)) return true;
  if (/(^|\.)securetoken\.googleapis\.com$/.test(h)) return true;
  if (/(^|\.)firestore\.googleapis\.com$/.test(h)) return true;
  if (/(^|\.)firebasestorage\.googleapis\.com$/.test(h)) return true;
  if (/(^|\.)firebasedatabase\.app$/.test(h)) return true;
  // Rede de segurança: qualquer outra API do Google que não seja as fontes.
  if (/googleapis\.com$/.test(h) && h !== 'fonts.googleapis.com') return true;
  return false;
}

/* ---------------------------------------------------------------------------
   Estáticos de fora do domínio que VALE A PENA guardar. São URLs versionadas
   (xlsx 0.18.5, html2pdf 0.10.1, firebasejs 10.12.2, fontes), então o conteúdo
   de cada URL não muda — guardar não corre risco de servir versão errada.
   --------------------------------------------------------------------------- */
function ehEstaticoDeCDN(url) {
  const h = url.hostname;
  if (h === 'cdnjs.cloudflare.com') return true;
  if (h === 'fonts.googleapis.com') return true;
  if (h === 'fonts.gstatic.com') return true;
  if (h === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) return true;
  return false;
}

/* Só guardamos respostas realmente aproveitáveis.
   - status 200 apenas (nada de erro nem 206/parcial);
   - nada de resposta redirecionada: se ela for devolvida depois numa navegação,
     o navegador rejeita e a tela fica em branco;
   - resposta opaca (type 'opaque') também fica de fora: não dá para saber se
     deu certo e ela ocupa espaço à toa. */
function podeGuardar(res) {
  return !!res
    && res.status === 200
    && !res.redirected
    && (res.type === 'basic' || res.type === 'cors' || res.type === 'default');
}

/* ============================ INSTALAÇÃO ================================== */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(() => {}))   // pré-carga é bônus, não requisito
      .catch(() => {})
      .then(() => self.skipWaiting())                  // versão nova assume sem esperar
  );
});

/* ============================= ATIVAÇÃO =================================== */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => {
        // Navigation preload deixa a primeira navegação mais rápida quando existe.
        if (self.registration.navigationPreload) {
          return self.registration.navigationPreload.enable().catch(() => {});
        }
      })
      .then(() => self.clients.claim())
  );
});

/* ===================== MENSAGENS VINDAS DA PÁGINA ========================= */
self.addEventListener('message', (e) => {
  const dado = e.data;

  // O HTML do app manda 'SKIP_WAITING' assim que detecta uma versão nova.
  if (dado === 'SKIP_WAITING' || (dado && dado.type === 'SKIP_WAITING')) {
    self.skipWaiting();
    return;
  }

  // Utilitário: descobrir qual versão está ativa (útil para depurar publicação).
  if (dado === 'GET_VERSION' || (dado && dado.type === 'GET_VERSION')) {
    const porta = e.ports && e.ports[0];
    if (porta) porta.postMessage({ cache: CACHE });
    return;
  }

  // Utilitário: limpar tudo e recomeçar do zero.
  if (dado === 'CLEAR_CACHE' || (dado && dado.type === 'CLEAR_CACHE')) {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});

/* ============================== REQUISIÇÕES =============================== */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Firebase e afins: passa direto, sem service worker no meio.
  if (ehChamadaDeDados(url)) return;

  const mesmaOrigem = (url.origin === self.location.origin);
  const ehHTML = req.mode === 'navigate'
    || req.destination === 'document'
    || (req.headers.get('accept') || '').includes('text/html');

  /* ---------------- HTML: rede primeiro, sempre a versão publicada ---------
     O `cache: 'reload'` é o detalhe que resolve o problema clássico de
     hospedagem estática (GitHub Pages inclusive): o HTML costuma vir com
     max-age de alguns minutos, então um fetch comum poderia devolver a
     versão anterior guardada pelo próprio navegador. Com 'reload' a busca
     vai até o servidor. Se o navegador não aceitar essa opção, cai no
     fetch normal — e, sem rede, no cache. */
  if (ehHTML) {
    e.respondWith((async () => {
      // Resposta já adiantada pelo navegador, quando disponível.
      try {
        const preload = await e.preloadResponse;
        if (preload) {
          if (mesmaOrigem && podeGuardar(preload)) {
            const copia = preload.clone();
            caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
          }
          return preload;
        }
      } catch (_) { /* segue para a rede */ }

      try {
        let res;
        try {
          res = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' });
        } catch (_) {
          res = await fetch(req);
        }
        if (mesmaOrigem && podeGuardar(res)) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
        }
        return res;
      } catch (_) {
        // Offline: entrega a última versão guardada.
        const doCache = await caches.match(req);
        if (doCache) return doCache;
        const raiz = await caches.match('./');
        if (raiz) return raiz;
        return new Response(
          '<!doctype html><meta charset="utf-8">' +
          '<title>Central — offline</title>' +
          '<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
          'background:#070d18;color:#e6edf7;display:flex;align-items:center;' +
          'justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;">' +
          '<div><h1 style="font-size:20px;margin:0 0 8px;">Sem conexão</h1>' +
          '<p style="color:#6f84a6;font-size:14px;margin:0;">' +
          'Conecte-se à internet e abra o app novamente.</p></div>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  /* ------------- Demais estáticos: cache primeiro, atualiza atrás ---------- */
  const guardavel = mesmaOrigem || ehEstaticoDeCDN(url);
  if (!guardavel) return;   // qualquer outra origem passa direto pela rede

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const guardado = await cache.match(req);

    const daRede = fetch(req).then(res => {
      if (podeGuardar(res)) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => guardado);

    // Já tem no cache? Entrega na hora e atualiza em segundo plano.
    if (guardado) {
      e.waitUntil(daRede.catch(() => {}));
      return guardado;
    }
    return daRede;
  })());
});
