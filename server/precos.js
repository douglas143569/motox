const { PRECO } = require('./config');

const VELOCIDADE_MEDIA_KMH = 25; // usada quando não há serviço de rotas

function distanciaKm(a, b) {
  const R = 6371;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const cacheRotas = new Map();

// Calcula a rota real pelas ruas (OSRM). Sem internet, estima pela linha reta x 1,3.
async function calcularRota(origem, destino, { usarOsrm = true } = {}) {
  const chave = [origem.lat, origem.lng, destino.lat, destino.lng].map((n) => n.toFixed(5)).join(',');
  if (cacheRotas.has(chave)) return cacheRotas.get(chave);

  let rota = null;
  if (usarOsrm) {
    try {
      const url =
        'https://router.project-osrm.org/route/v1/driving/' +
        `${origem.lng},${origem.lat};${destino.lng},${destino.lat}?overview=simplified&geometries=geojson`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const dados = await resp.json();
      const r = dados.routes && dados.routes[0];
      if (r) {
        rota = {
          distanciaKm: r.distance / 1000,
          // OSRM calcula para carro; moto no trânsito urbano costuma ser ~20% mais rápida
          duracaoMin: (r.duration / 60) * 0.8,
          geometria: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
          fonte: 'osrm',
        };
      }
    } catch {
      // sem rota real: segue para a estimativa
    }
  }
  if (!rota) {
    const km = distanciaKm(origem, destino) * 1.3;
    rota = {
      distanciaKm: km,
      duracaoMin: (km / VELOCIDADE_MEDIA_KMH) * 60,
      geometria: [
        [origem.lat, origem.lng],
        [destino.lat, destino.lng],
      ],
      fonte: 'estimativa',
    };
  }
  rota.distanciaKm = Math.round(rota.distanciaKm * 100) / 100;
  rota.duracaoMin = Math.max(3, Math.round(rota.duracaoMin));
  if (cacheRotas.size > 500) cacheRotas.clear();
  cacheRotas.set(chave, rota);
  return rota;
}

const arred2 = (v) => Math.round(v * 100) / 100;

const meioReal = (v) => Math.ceil(Math.round(v * 100) / 50) / 2; // arredonda para cima em R$ 0,50

// tarifas: as do painel admin (server/tarifas.js); sem elas, usa o padrão do config.
// dinamica: { mult, motivos } da tarifa dinâmica do momento (1 = sem adicional).
function calcularPreco({ distanciaKm, tamanho = 'pequeno', idaVolta = false }, tarifas = PRECO, dinamica = null) {
  const t = tarifas.tamanhos[tamanho];
  if (!t) throw new Error('Tamanho inválido');
  let valor = Math.max(tarifas.minimo, tarifas.base + tarifas.porKm * distanciaKm) * t.mult;
  if (idaVolta) valor *= tarifas.idaVolta;
  const precoBase = meioReal(valor);

  const mult = dinamica ? dinamica.mult : 1;
  const adicionalDinamico = mult > 1 ? meioReal(precoBase * (mult - 1)) : 0;
  const repasse = tarifas.dinamica ? tarifas.dinamica.repasseMotoboy : 1;

  const preco = precoBase + adicionalDinamico;
  // comissão só sobre o preço base; do adicional dinâmico, o motoboy recebe o repasse configurado
  const ganhoMotoboy = arred2(precoBase * (1 - tarifas.taxaPlataforma) + adicionalDinamico * repasse);
  return {
    preco,
    precoBase,
    adicionalDinamico,
    motivosDinamica: adicionalDinamico ? dinamica.motivos : [],
    ganhoMotoboy,
    taxaPlataforma: arred2(preco - ganhoMotoboy),
  };
}

module.exports = { distanciaKm, calcularRota, calcularPreco };
