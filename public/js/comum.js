// Utilitários compartilhados por todas as telas.

const Sessao = {
  get token() {
    return localStorage.getItem('motox_token');
  },
  get usuario() {
    try {
      return JSON.parse(localStorage.getItem('motox_usuario'));
    } catch {
      return null;
    }
  },
  salvar({ token, usuario }) {
    localStorage.setItem('motox_token', token);
    localStorage.setItem('motox_usuario', JSON.stringify(usuario));
  },
  async sair() {
    try {
      await api('/auth/sair', { metodo: 'POST' });
    } catch {}
    localStorage.removeItem('motox_token');
    localStorage.removeItem('motox_usuario');
    location.href = '/';
  },
};

async function api(caminho, { metodo = 'GET', corpo } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (Sessao.token) headers.Authorization = 'Bearer ' + Sessao.token;
  let resp;
  try {
    resp = await fetch(MOTOX.servidor + '/api' + caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  } catch {
    throw new Error('Sem conexão com o servidor.');
  }
  let dados = null;
  try {
    dados = await resp.json();
  } catch {}
  if (resp.status === 401 && Sessao.token) {
    localStorage.removeItem('motox_token');
    location.href = '/';
  }
  if (!resp.ok) throw new Error((dados && dados.erro) || 'Falha na comunicação com o servidor.');
  return dados;
}

// com .html para funcionar também dentro do app, que não tem o servidor Express
const PAGINA_DO_TIPO = { cliente: '/cliente.html', motoboy: '/motoboy.html', admin: '/admin.html' };

function exigirLogin(tipo) {
  const u = Sessao.usuario;
  if (!Sessao.token || !u) {
    location.href = '/';
    throw new Error('sem sessão');
  }
  if (tipo && u.tipo !== tipo) {
    location.href = PAGINA_DO_TIPO[u.tipo] || '/';
    throw new Error('perfil errado');
  }
  vigiarTrocaDeConta(Sessao.token);
  return u;
}

// Abas do mesmo navegador compartilham a sessão. Se outra aba entrar com outra conta (ex.: cliente
// numa aba e motoboy na outra), esta aba não pode continuar agindo como se fosse a conta antiga.
function vigiarTrocaDeConta(tokenDestaPagina) {
  window.addEventListener('storage', (e) => {
    if (e.key !== 'motox_token' || e.newValue === tokenDestaPagina) return;
    if (e.newValue) {
      sessionStorage.setItem(
        'motox_aviso',
        'Você entrou com outra conta em outra aba deste navegador, e esta aba passou para essa conta. ' +
          'Para usar cliente e motoboy ao mesmo tempo, use navegadores diferentes ou uma janela anônima.'
      );
    }
    location.href = '/';
  });
}

// Aviso deixado antes de um redirecionamento (conta desativada, troca de conta...): mostra na página seguinte
window.addEventListener('DOMContentLoaded', () => {
  const aviso = sessionStorage.getItem('motox_aviso');
  if (!aviso || window.redirecionando) return;
  sessionStorage.removeItem('motox_aviso');
  setTimeout(() => toast(aviso, 'erro'), 300);
});

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const km = (v) => `${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
const minutos = (v) => (v < 60 ? `${Math.round(v)} min` : `${Math.floor(v / 60)}h${String(Math.round(v % 60)).padStart(2, '0')}`);
const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');
const dataHora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const iniciais = (nome) => String(nome || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const formatarTel = (t) => {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
};
const notaTexto = (n) => (n == null ? 'Novo' : `★ ${n.toFixed(1).replace('.', ',')}`);

function toast(msg, tipo = '') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  box.appendChild(t);
  // avisos longos ficam mais tempo, para dar tempo de ler
  setTimeout(() => t.remove(), Math.max(tipo === 'erro' ? 5000 : 3200, msg.length * 55));
}

// Executa uma ação assíncrona travando o botão para evitar clique duplo.
async function acao(botao, fn) {
  if (botao) botao.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    if (botao) botao.disabled = false;
  }
}

const STATUS = {
  procurando: { texto: 'Procurando motoboy', selo: 'alerta' },
  a_caminho_coleta: { texto: 'Motoboy a caminho da coleta', selo: 'info' },
  no_local_coleta: { texto: 'Motoboy no local de coleta', selo: 'info' },
  em_rota: { texto: 'Pacote a caminho da entrega', selo: 'info' },
  retornando: { texto: 'Entregue · motoboy retornando', selo: 'info' },
  entregue: { texto: 'Entregue', selo: 'ok' },
  cancelada: { texto: 'Cancelada', selo: 'perigo' },
  expirada: { texto: 'Sem motoboy disponível', selo: 'perigo' },
};
const seloStatus = (s) => `<span class="selo ${STATUS[s]?.selo || ''}">${esc(STATUS[s]?.texto || s)}</span>`;
const PAGAMENTO_TEXTO = { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' };
const TAMANHO_TEXTO = { pequeno: 'Pequeno', medio: 'Médio', grande: 'Grande' };

function etapasHtml(c) {
  const lista = [
    ['Pedido feito', c.criadoEm],
    ['Motoboy a caminho', c.aceitoEm],
    ['Chegou na coleta', c.chegouColetaEm],
    ['Pacote coletado', c.coletadoEm],
    ['Entregue', c.entregueEm],
  ];
  if (c.idaVolta) lista.push(['Retornou à origem', c.finalizadoEm]);
  const ultima = lista.reduce((acc, [, t], i) => (t ? i : acc), -1);
  return `<ol class="etapas">${lista
    .map(([nome, t], i) => {
      const cls = i < ultima ? 'feita' : i === ultima ? 'atual' : '';
      return `<li class="${cls}">${esc(nome)}${t ? `<small>${hora(t)}</small>` : ''}</li>`;
    })
    .join('')}</ol>`;
}

function distanciaKm(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// Estimativa simples de chegada para moto na cidade (fator de ruas 1,3 a 25 km/h)
const etaMin = (a, b) => Math.max(1, Math.round(((distanciaKm(a, b) * 1.3) / 25) * 60));

// ---------- mapa (Leaflet + OpenStreetMap/CARTO, sem chave de API) ----------

const CENTRO_PADRAO = [-23.5505, -46.6333]; // São Paulo

function criarMapa(id, centro = CENTRO_PADRAO) {
  const mapa = L.map(id, { zoomControl: false, attributionControl: true }).setView(centro, 14);
  // Em produção, troque por um provedor com chave (MapTiler, Stadia, Mapbox) — o servidor
  // público do OpenStreetMap é só para uso leve.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(mapa);
  return mapa;
}

const icone = (html, tam, ancora) =>
  L.divIcon({ className: 'marcador', html, iconSize: [tam, tam], iconAnchor: ancora || [tam / 2, tam / 2] });
const ICONES = {
  origem: () => icone('<div class="pino origem"></div>', 30, [15, 34]),
  destino: () => icone('<div class="pino destino"></div>', 30, [15, 34]),
  moto: () => icone('<div class="moto">🛵</div>', 40),
  eu: () => icone('<div class="eu"></div>', 20),
};

// Move um marcador suavemente até a nova posição
function animarMarcador(marcador, destino, ms = 900) {
  const ini = marcador.getLatLng();
  const t0 = performance.now();
  const passo = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    marcador.setLatLng([ini.lat + (destino[0] - ini.lat) * k, ini.lng + (destino[1] - ini.lng) * k]);
    if (k < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

function encerrarSessaoLocal(mensagem) {
  localStorage.removeItem('motox_token');
  localStorage.removeItem('motox_usuario');
  if (mensagem) sessionStorage.setItem('motox_aviso', mensagem);
  location.href = '/';
}

function conectarSocket() {
  const s = io(MOTOX.servidor || undefined, { auth: { token: Sessao.token } });
  // conta bloqueada/excluída pelo admin enquanto o app estava aberto
  s.on('conta:encerrada', () => encerrarSessaoLocal('Sua conta foi desativada. Fale com o suporte MotoX.'));
  s.on('connect_error', (e) => e.message === 'nao_autorizado' && encerrarSessaoLocal('Sua sessão expirou. Entre novamente.'));
  return s;
}

function obterGps(opcoes = {}) {
  return new Promise((ok, falha) => {
    if (!navigator.geolocation) return falha(new Error('GPS indisponível'));
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => falha(e),
      { enableHighAccuracy: true, timeout: 8000, ...opcoes }
    );
  });
}

const linkNavegacao = (p) => ({
  google: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`,
  waze: `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`,
});
