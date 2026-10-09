// Tarifas editáveis pelo painel admin (guardadas no banco) e tarifa dinâmica.
const { PRECO } = require('./config');

const FUSO = 'America/Sao_Paulo'; // horários de pico seguem o horário de Brasília, onde quer que o servidor esteja

const PADRAO = {
  base: PRECO.base,
  porKm: PRECO.porKm,
  minimo: PRECO.minimo,
  taxaPlataforma: PRECO.taxaPlataforma,
  idaVolta: PRECO.idaVolta,
  distanciaMaxKm: PRECO.distanciaMaxKm,
  tamanhos: PRECO.tamanhos,
  dinamica: {
    // modo chuva: ligado manualmente pelo admin quando começa a chover
    chuva: { ativo: false, mult: 1.2 },
    // faixas de horário com adicional (dias: 0 = domingo ... 6 = sábado)
    faixas: [
      { nome: 'Pico do almoço', dias: [1, 2, 3, 4, 5, 6], inicio: '11:00', fim: '14:00', mult: 1.15, ativo: false },
      { nome: 'Noturno', dias: [0, 1, 2, 3, 4, 5, 6], inicio: '22:00', fim: '06:00', mult: 1.25, ativo: false },
    ],
    teto: 1.5, // o adicional somado nunca passa disto (1,5 = +50%)
    repasseMotoboy: 1, // fração do adicional que vai para o motoboy (1 = 100%)
  },
};

class ErroTarifa extends Error {}

const clonar = (o) => JSON.parse(JSON.stringify(o));

function numero(v, nome, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ErroTarifa(`${nome}: informe um valor entre ${String(min).replace('.', ',')} e ${String(max).replace('.', ',')}.`);
  }
  return Math.round(n * 1000) / 1000;
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// Confere e normaliza as tarifas enviadas pelo painel. Nunca confia no que chega.
function validarTarifas(t) {
  if (!t || typeof t !== 'object') throw new ErroTarifa('Tarifas inválidas.');
  const r = {
    base: numero(t.base, 'Bandeirada', 0, 100),
    porKm: numero(t.porKm, 'Valor por km', 0, 30),
    minimo: numero(t.minimo, 'Valor mínimo', 0, 300),
    taxaPlataforma: numero(t.taxaPlataforma, 'Comissão da plataforma', 0, 0.5),
    idaVolta: numero(t.idaVolta, 'Multiplicador de ida e volta', 1, 3),
    distanciaMaxKm: numero(t.distanciaMaxKm, 'Distância máxima', 1, 300),
    tamanhos: {},
    dinamica: {},
  };
  for (const [k, padrao] of Object.entries(PADRAO.tamanhos)) {
    const v = (t.tamanhos || {})[k] || {};
    r.tamanhos[k] = { nome: padrao.nome, desc: padrao.desc, mult: numero(v.mult, `Multiplicador do tamanho ${padrao.nome}`, 0.5, 5) };
  }
  const d = t.dinamica || {};
  const chuva = d.chuva || {};
  r.dinamica.chuva = { ativo: !!chuva.ativo, mult: numero(chuva.mult, 'Adicional de chuva', 1, 3) };
  r.dinamica.teto = numero(d.teto, 'Teto da tarifa dinâmica', 1, 3);
  r.dinamica.repasseMotoboy = numero(d.repasseMotoboy, 'Repasse do adicional ao motoboy', 0, 1);
  if (!Array.isArray(d.faixas) || d.faixas.length > 20) throw new ErroTarifa('Faixas de horário inválidas (máximo 20).');
  r.dinamica.faixas = d.faixas.map((f, i) => {
    const nome = String(f.nome || '').trim().slice(0, 40);
    if (!nome) throw new ErroTarifa(`Faixa ${i + 1}: informe um nome.`);
    if (!HORA.test(f.inicio) || !HORA.test(f.fim)) throw new ErroTarifa(`Faixa "${nome}": horário inválido (use HH:MM).`);
    if (f.inicio === f.fim) throw new ErroTarifa(`Faixa "${nome}": início e fim não podem ser iguais.`);
    const dias = [...new Set((f.dias || []).map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort();
    if (!dias.length) throw new ErroTarifa(`Faixa "${nome}": escolha pelo menos um dia.`);
    return { nome, dias, inicio: f.inicio, fim: f.fim, mult: numero(f.mult, `Adicional da faixa "${nome}"`, 1, 3), ativo: !!f.ativo };
  });
  return r;
}

// ---------- leitura e gravação ----------

const cache = new WeakMap(); // db -> tarifas

function obterTarifas(db) {
  if (cache.has(db)) return cache.get(db);
  const linha = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'tarifas'").get();
  let t = clonar(PADRAO);
  if (linha) {
    try {
      t = validarTarifas({ ...t, ...JSON.parse(linha.valor) });
    } catch {
      // registro corrompido: segue com o padrão em vez de derrubar o sistema
    }
  }
  cache.set(db, t);
  return t;
}

function infoAlteracao(db) {
  return (
    db
      .prepare(
        `SELECT c.atualizado_em AS em, u.nome AS por FROM configuracoes c
         LEFT JOIN usuarios u ON u.id = c.atualizado_por WHERE c.chave = 'tarifas'`
      )
      .get() || null
  );
}

function salvarTarifas(db, novas, usuarioId) {
  const t = validarTarifas(novas);
  const agora = Date.now();
  db.prepare(
    `INSERT INTO configuracoes (chave, valor, atualizado_em, atualizado_por) VALUES ('tarifas', ?, ?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`
  ).run(JSON.stringify(t), agora, usuarioId);
  db.prepare('INSERT INTO historico_tarifas (tarifas_json, usuario_id, criado_em) VALUES (?, ?, ?)').run(
    JSON.stringify(t),
    usuarioId,
    agora
  );
  cache.set(db, t);
  return t;
}

// ---------- tarifa dinâmica ----------

function horaBrasilia(ms) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday);
  return { dia, minutos: Number(partes.hour) * 60 + Number(partes.minute) };
}

const paraMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Faixa que atravessa a meia-noite (ex.: 22:00–06:00) vale do dia marcado até a manhã seguinte.
function faixaAtiva(f, { dia, minutos }) {
  const ini = paraMinutos(f.inicio);
  const fim = paraMinutos(f.fim);
  if (ini < fim) return f.dias.includes(dia) && minutos >= ini && minutos < fim;
  if (minutos >= ini) return f.dias.includes(dia);
  return minutos < fim && f.dias.includes((dia + 6) % 7);
}

// Multiplicador atual e os motivos (mostrados ao cliente e ao motoboy, por transparência).
// Faixas de horário não se somam: vale a maior. A chuva multiplica por cima. Tudo limitado ao teto.
function dinamicaAgora(t, agora = Date.now()) {
  const d = t.dinamica;
  const h = horaBrasilia(agora);
  const motivos = [];
  let mult = 1;
  const faixas = d.faixas.filter((f) => f.ativo && faixaAtiva(f, h)).sort((a, b) => b.mult - a.mult);
  if (faixas[0]) {
    mult = faixas[0].mult;
    motivos.push(faixas[0].nome);
  }
  if (d.chuva.ativo) {
    mult *= d.chuva.mult;
    motivos.push('Chuva');
  }
  mult = Math.min(Math.round(mult * 1000) / 1000, d.teto);
  return { mult, motivos };
}

module.exports = { PADRAO, ErroTarifa, validarTarifas, obterTarifas, salvarTarifas, infoAlteracao, dinamicaAgora, faixaAtiva, horaBrasilia };
