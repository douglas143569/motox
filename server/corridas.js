// Estados de uma corrida:
// procurando -> a_caminho_coleta -> no_local_coleta -> em_rota -> (retornando) -> entregue
// Saídas alternativas: cancelada (pelo cliente) e expirada (ninguém aceitou a tempo).
const ATIVOS = ['procurando', 'a_caminho_coleta', 'no_local_coleta', 'em_rota', 'retornando'];
const ATIVOS_SQL = ATIVOS.map((s) => `'${s}'`).join(',');

const notaDe = (u) => (u && u.nota_qtd ? Math.round((u.nota_soma / u.nota_qtd) * 10) / 10 : null);
const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0];

function buscarCorrida(db, id) {
  return db.prepare('SELECT * FROM corridas WHERE id = ?').get(id) || null;
}

function buscarUsuario(db, id) {
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id) || null;
}

function usuarioPublico(u) {
  return {
    id: u.id,
    nome: u.nome,
    telefone: u.telefone,
    tipo: u.tipo,
    placa: u.placa,
    moto: u.moto,
    nota: notaDe(u),
    corridas: u.nota_qtd,
    statusCadastro: u.status_cadastro || 'aprovado',
    motivoReprovacao: u.motivo_reprovacao || null,
  };
}

// Cada participante enxerga só o que precisa. O PIN de entrega, por exemplo,
// nunca vai para o motoboy: ele precisa recebê-lo do destinatário.
function serializarCorrida(db, c, visao, posicaoMotoboy = null) {
  const r = {
    id: c.id,
    status: c.status,
    origem: { endereco: c.origem_end, lat: c.origem_lat, lng: c.origem_lng },
    destino: { endereco: c.destino_end, lat: c.destino_lat, lng: c.destino_lng },
    distanciaKm: c.distancia_km,
    duracaoMin: c.duracao_min,
    rota: c.rota_json ? JSON.parse(c.rota_json) : null,
    tamanho: c.tamanho,
    idaVolta: !!c.ida_volta,
    codigoRastreio: c.codigo_rastreio,
    criadoEm: c.criado_em,
    aceitoEm: c.aceito_em,
    chegouColetaEm: c.chegou_coleta_em,
    coletadoEm: c.coletado_em,
    entregueEm: c.entregue_em,
    finalizadoEm: c.finalizado_em,
    canceladoEm: c.cancelado_em,
    canceladoPor: c.cancelado_por,
  };

  const m = c.motoboy_id ? buscarUsuario(db, c.motoboy_id) : null;
  if (m) {
    r.motoboy = { nome: m.nome, moto: m.moto, placa: m.placa, nota: notaDe(m), posicao: posicaoMotoboy };
  }

  if (visao === 'publico') {
    if (r.motoboy) r.motoboy.nome = primeiroNome(m.nome);
    return r;
  }

  Object.assign(r, {
    pagamento: c.pagamento,
    preco: c.preco,
    precoOriginal: c.preco_original ?? c.preco,
    desconto: c.desconto || 0,
    cupom: c.cupom,
    adicionalDinamico: c.adicional_dinamico || 0,
    motivoDinamico: c.motivo_dinamico,
    observacoes: c.observacoes,
    destinatario: { nome: c.destinatario_nome, telefone: c.destinatario_tel },
  });

  if (visao === 'cliente') {
    r.pin = c.pin_entrega;
    r.minhaAvaliacao = c.avaliacao_do_cliente;
    if (r.motoboy) r.motoboy.telefone = m.telefone;
  } else if (visao === 'motoboy') {
    r.ganhoMotoboy = c.ganho_motoboy;
    r.taxaPlataforma = c.taxa_plataforma;
    r.minhaAvaliacao = c.avaliacao_do_motoboy;
    const cli = buscarUsuario(db, c.cliente_id);
    r.cliente = { nome: cli.nome, telefone: cli.telefone, nota: notaDe(cli) };
  } else if (visao === 'admin') {
    r.ganhoMotoboy = c.ganho_motoboy;
    r.taxaPlataforma = c.taxa_plataforma;
    r.cliente = { nome: buscarUsuario(db, c.cliente_id).nome };
    r.avaliacaoDoCliente = c.avaliacao_do_cliente;
    r.avaliacaoDoMotoboy = c.avaliacao_do_motoboy;
  }
  return r;
}

module.exports = {
  ATIVOS,
  ATIVOS_SQL,
  notaDe,
  buscarCorrida,
  buscarUsuario,
  usuarioPublico,
  serializarCorrida,
};
