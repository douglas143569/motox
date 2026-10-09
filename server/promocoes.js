// Cupons e promoções. O desconto sai da parte da plataforma: o ganho do motoboy nunca diminui.
class ErroCupom extends Error {}

const STATUS_QUE_CONTAM = "status NOT IN ('cancelada','expirada')"; // corrida cancelada devolve o uso do cupom
const arred2 = (v) => Math.round(v * 100) / 100;

const normalizarCodigo = (c) => String(c || '').trim().toUpperCase();

function usos(db, promoId, clienteId = null) {
  const sql = `SELECT COUNT(*) AS n FROM corridas WHERE promocao_id = ? AND ${STATUS_QUE_CONTAM}${clienteId ? ' AND cliente_id = ?' : ''}`;
  return db.prepare(sql).get(...(clienteId ? [promoId, clienteId] : [promoId])).n;
}

function ehPrimeiraCorrida(db, clienteId) {
  return !db.prepare(`SELECT 1 FROM corridas WHERE cliente_id = ? AND ${STATUS_QUE_CONTAM}`).get(clienteId);
}

function calcularDesconto(p, preco) {
  let d = p.tipo === 'percentual' ? (preco * p.valor) / 100 : p.valor;
  if (p.tipo === 'percentual' && p.desconto_max) d = Math.min(d, p.desconto_max);
  return arred2(Math.min(d, preco));
}

// Situação para o painel: ativa, agendada, encerrada, esgotada ou pausada
function situacao(db, p, agora = Date.now()) {
  if (!p.ativo) return 'pausada';
  if (p.fim && agora > p.fim) return 'encerrada';
  if (p.inicio && agora < p.inicio) return 'agendada';
  if (p.limite_total && usos(db, p.id) >= p.limite_total) return 'esgotada';
  return 'ativa';
}

// Por que esta promoção não vale para este cliente/pedido? (null = vale)
function motivoRecusa(db, p, clienteId, preco, agora) {
  const s = situacao(db, p, agora);
  if (s === 'pausada' || s === 'encerrada') return 'Este cupom não está mais válido.';
  if (s === 'agendada') return `Este cupom vale a partir de ${new Date(p.inicio).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`;
  if (s === 'esgotada') return 'Este cupom esgotou.';
  if (p.pedido_minimo && preco < p.pedido_minimo) {
    return `Este cupom vale para entregas a partir de R$ ${p.pedido_minimo.toFixed(2).replace('.', ',')}.`;
  }
  if (p.so_primeira_corrida && !ehPrimeiraCorrida(db, clienteId)) return 'Este cupom é só para a primeira entrega.';
  if (p.limite_por_cliente && usos(db, p.id, clienteId) >= p.limite_por_cliente) {
    return 'Você já usou este cupom o máximo de vezes permitido.';
  }
  return null;
}

// Cupom digitado pelo cliente. Lança ErroCupom com a explicação se não puder ser usado.
function aplicarCupom(db, { codigo, clienteId, preco, agora = Date.now() }) {
  const p = db.prepare('SELECT * FROM promocoes WHERE codigo = ?').get(normalizarCodigo(codigo));
  if (!p) throw new ErroCupom('Cupom não encontrado. Confira o código.');
  const motivo = motivoRecusa(db, p, clienteId, preco, agora);
  if (motivo) throw new ErroCupom(motivo);
  return { promo: p, desconto: calcularDesconto(p, preco) };
}

// Sem cupom digitado: aplica sozinha a melhor promoção automática (ex.: boas-vindas)
function melhorAutomatica(db, { clienteId, preco, agora = Date.now() }) {
  let melhor = null;
  for (const p of db.prepare('SELECT * FROM promocoes WHERE automatica = 1 AND ativo = 1').all()) {
    if (motivoRecusa(db, p, clienteId, preco, agora)) continue;
    const desconto = calcularDesconto(p, preco);
    if (!melhor || desconto > melhor.desconto) melhor = { promo: p, desconto };
  }
  return melhor;
}

// ---------- cadastro pelo admin ----------

function validarPromocao(b) {
  const codigo = normalizarCodigo(b.codigo);
  if (!/^[A-Z0-9]{3,20}$/.test(codigo)) throw new ErroCupom('Código: de 3 a 20 letras ou números, sem espaços.');
  const descricao = String(b.descricao || '').trim().slice(0, 80);
  if (!descricao) throw new ErroCupom('Descreva a promoção (o cliente vê este texto).');
  const tipo = b.tipo === 'fixo' ? 'fixo' : 'percentual';
  const valor = Number(b.valor);
  if (!Number.isFinite(valor) || valor <= 0 || (tipo === 'percentual' && valor > 100) || (tipo === 'fixo' && valor > 500)) {
    throw new ErroCupom(tipo === 'percentual' ? 'Percentual entre 1 e 100.' : 'Valor do desconto entre R$ 0,01 e R$ 500.');
  }
  const opcional = (v, nome, max) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new ErroCupom(`${nome}: valor inválido.`);
    return n || null;
  };
  const inteiro = (v, nome) => {
    const n = opcional(v, nome, 1e6);
    if (n != null && !Number.isInteger(n)) throw new ErroCupom(`${nome}: use um número inteiro.`);
    return n;
  };
  const data = (v, nome) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1e12) throw new ErroCupom(`${nome}: data inválida.`);
    return n;
  };
  const r = {
    codigo,
    descricao,
    tipo,
    valor: arred2(valor),
    desconto_max: tipo === 'percentual' ? opcional(b.descontoMax, 'Desconto máximo', 500) : null,
    pedido_minimo: opcional(b.pedidoMinimo, 'Pedido mínimo', 1000),
    inicio: data(b.inicio, 'Início'),
    fim: data(b.fim, 'Fim'),
    limite_total: inteiro(b.limiteTotal, 'Limite de usos'),
    limite_por_cliente: inteiro(b.limitePorCliente, 'Limite por cliente'),
    so_primeira_corrida: b.soPrimeiraCorrida ? 1 : 0,
    automatica: b.automatica ? 1 : 0,
    ativo: b.ativo === false ? 0 : 1,
  };
  if (r.inicio && r.fim && r.fim <= r.inicio) throw new ErroCupom('O fim precisa ser depois do início.');
  return r;
}

function serializarPromocao(db, p) {
  const resumo = db
    .prepare(`SELECT COUNT(*) AS usos, COALESCE(SUM(desconto), 0) AS total FROM corridas WHERE promocao_id = ? AND ${STATUS_QUE_CONTAM}`)
    .get(p.id);
  return {
    id: p.id,
    codigo: p.codigo,
    descricao: p.descricao,
    tipo: p.tipo,
    valor: p.valor,
    descontoMax: p.desconto_max,
    pedidoMinimo: p.pedido_minimo,
    inicio: p.inicio,
    fim: p.fim,
    limiteTotal: p.limite_total,
    limitePorCliente: p.limite_por_cliente,
    soPrimeiraCorrida: !!p.so_primeira_corrida,
    automatica: !!p.automatica,
    ativo: !!p.ativo,
    situacao: situacao(db, p),
    usos: resumo.usos,
    totalDescontado: arred2(resumo.total),
    criadoEm: p.criado_em,
  };
}

module.exports = {
  ErroCupom,
  normalizarCodigo,
  aplicarCupom,
  melhorAutomatica,
  calcularDesconto,
  validarPromocao,
  serializarPromocao,
};
