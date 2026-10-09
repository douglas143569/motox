const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { hashSenha, conferirSenha, novoToken, usuarioPorToken } = require('./auth');
const { calcularRota, calcularPreco, distanciaKm } = require('./precos');
const { ATIVOS_SQL, buscarCorrida, buscarUsuario, usuarioPublico } = require('./corridas');
const { ErroDespacho } = require('./despacho');
const { ErroTarifa, PADRAO, obterTarifas, salvarTarifas, validarTarifas, infoAlteracao, dinamicaAgora } = require('./tarifas');
const {
  ErroDocumento,
  validarDocumentos,
  gravarDocumentos,
  documentosAtuais,
  caminhoDocumento,
  apagarDocumentos,
} = require('./documentos');
const { ErroCupom, aplicarCupom, melhorAutomatica, validarPromocao, serializarPromocao, normalizarCodigo } = require('./promocoes');

class ErroApi extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const PAGAMENTOS = ['pix', 'cartao', 'dinheiro'];
const soDigitos = (v) => String(v || '').replace(/\D/g, '');
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function ponto(p, nome) {
  const lat = Number(p && p.lat);
  const lng = Number(p && p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ErroApi(400, `Informe o endereço de ${nome}.`);
  }
  return { lat, lng, endereco: texto(p.endereco, 300) || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
}

function criarRotas({ db, desp, usarOsrm, pastaDocumentos }) {
  const r = express.Router();

  // ---------- autenticação ----------

  const autenticar = (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const u = usuarioPorToken(db, token);
    if (!u) return next(new ErroApi(401, 'Sessão expirada. Entre novamente.'));
    req.usuario = u;
    next();
  };
  const PERFIL = { cliente: 'clientes', motoboy: 'motoboys', admin: 'o administrador' };
  const PERFIL_SINGULAR = { cliente: 'cliente', motoboy: 'motoboy', admin: 'administrador' };
  const exigir =
    (...tipos) =>
    (req, res, next) =>
      tipos.includes(req.usuario.tipo)
        ? next()
        : next(
            new ErroApi(
              403,
              `Esta ação é só para ${tipos.map((t) => PERFIL[t]).join(' ou ')}. ` +
                `Você está conectado como ${PERFIL_SINGULAR[req.usuario.tipo]}.`
            )
          );

  const abrirSessao = (u) => {
    const token = novoToken();
    db.prepare('INSERT INTO sessoes (token, usuario_id, criado_em) VALUES (?, ?, ?)').run(token, u.id, Date.now());
    return { token, usuario: usuarioPublico(u) };
  };

  const comoErroDoc = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ErroDocumento) throw new ErroApi(400, e.message);
      throw e;
    }
  };

  r.post('/auth/registrar', (req, res) => {
    const b = req.body || {};
    const nome = texto(b.nome, 80);
    const telefone = soDigitos(b.telefone);
    const senha = String(b.senha || '');
    const tipo = b.tipo;
    if (nome.length < 2) throw new ErroApi(400, 'Informe seu nome.');
    if (telefone.length < 10 || telefone.length > 11) throw new ErroApi(400, 'Telefone inválido. Use DDD + número.');
    if (senha.length < 6) throw new ErroApi(400, 'A senha precisa ter pelo menos 6 caracteres.');
    if (!['cliente', 'motoboy'].includes(tipo)) throw new ErroApi(400, 'Perfil inválido.');
    let placa = null;
    let moto = null;
    if (tipo === 'motoboy') {
      placa = texto(b.placa, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
      moto = texto(b.moto, 60);
      if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(placa)) throw new ErroApi(400, 'Placa inválida (ex.: ABC1D23).');
      if (moto.length < 2) throw new ErroApi(400, 'Informe o modelo da moto.');
    }
    if (db.prepare('SELECT 1 FROM usuarios WHERE telefone = ?').get(telefone)) {
      throw new ErroApi(409, 'Este telefone já está cadastrado. Faça login.');
    }
    // motoboy: CNH e CRLV são obrigatórios e conferidos antes de criar a conta
    const docs = tipo === 'motoboy' ? comoErroDoc(() => validarDocumentos(b.documentos)) : null;
    const { lastInsertRowid } = db
      .prepare(
        'INSERT INTO usuarios (nome, telefone, senha_hash, tipo, placa, moto, criado_em, status_cadastro) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(nome, telefone, hashSenha(senha), tipo, placa, moto, Date.now(), docs ? 'pendente' : 'aprovado');
    const id = Number(lastInsertRowid);
    if (docs) {
      try {
        gravarDocumentos(db, pastaDocumentos, id, docs);
      } catch (e) {
        // não deixa conta de motoboy sem documentos para trás
        apagarDocumentos(db, pastaDocumentos, id);
        db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
        throw e;
      }
    }
    if (docs) desp.io.to('admin').emit('cadastro:pendente', { id });
    res.status(201).json(abrirSessao(buscarUsuario(db, id)));
  });

  r.post('/auth/login', (req, res) => {
    const b = req.body || {};
    const u = db.prepare('SELECT * FROM usuarios WHERE telefone = ?').get(soDigitos(b.telefone));
    if (!u || !conferirSenha(String(b.senha || ''), u.senha_hash)) {
      throw new ErroApi(401, 'Telefone ou senha incorretos.');
    }
    if (u.bloqueado) throw new ErroApi(403, 'Sua conta está bloqueada. Fale com o suporte MotoX.');
    res.json(abrirSessao(u));
  });

  r.post('/auth/sair', autenticar, (req, res) => {
    const token = req.headers.authorization.replace(/^Bearer\s+/i, '');
    db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
    res.json({ ok: true });
  });

  r.get('/eu', autenticar, (req, res) => res.json(usuarioPublico(req.usuario)));

  r.get('/config', (req, res) => res.json({ tamanhos: obterTarifas(db).tamanhos, pagamentos: PAGAMENTOS }));

  // ---------- geocodificação (Photon/OpenStreetMap, gratuito) ----------

  const formatarLugar = (f) => {
    const p = f.properties || {};
    const rua = p.street ? `${p.street}${p.housenumber ? ', ' + p.housenumber : ''}` : '';
    const titulo = p.name && p.name !== p.street ? p.name : rua || p.name || 'Local';
    const detalhe = [titulo === rua ? '' : rua, p.district || p.locality, p.city, p.state]
      .filter(Boolean)
      .join(' · ');
    const [lng, lat] = f.geometry.coordinates;
    return { titulo, detalhe, endereco: [titulo, detalhe].filter(Boolean).join(' - '), lat, lng };
  };

  async function photon(params) {
    const resp = await fetch(`https://photon.komoot.io/api/?${params}`, {
      headers: { 'User-Agent': 'MotoX/0.1' },
      signal: AbortSignal.timeout(5000),
    });
    const dados = await resp.json();
    return (dados.features || []).filter((f) => !f.properties.countrycode || f.properties.countrycode === 'BR');
  }

  r.get('/geo/buscar', async (req, res) => {
    const q = texto(req.query.q, 120);
    if (q.length < 3) return res.json([]);
    const params = new URLSearchParams({ q, limit: '10', lang: 'default' });
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const temRef = Number.isFinite(lat) && Number.isFinite(lng);
    if (temRef) {
      params.set('lat', String(lat));
      params.set('lon', String(lng));
    }
    try {
      // Primeiro procura na região de quem pede (~100 km); senão, no Brasil todo.
      // Sem isso, "Rua dos Pinheiros" em SP pode virar uma rua homônima em outro estado.
      let achados = [];
      if (temRef) {
        const regional = new URLSearchParams(params);
        regional.set('bbox', [lng - 1, lat - 1, lng + 1, lat + 1].join(','));
        achados = await photon(regional);
      }
      if (!achados.length) achados = await photon(params);

      const numero = (q.match(/\b(\d{1,5})\b/) || [])[1];
      const vistos = new Set();
      const lista = [];
      for (const f of achados) {
        const l = formatarLugar(f);
        // rua sem numeração no mapa: mantém o número digitado (o pino pode ser ajustado arrastando)
        if (numero && f.properties.type === 'street' && !f.properties.housenumber) {
          l.titulo = `${l.titulo}, ${numero}`;
          l.endereco = [l.titulo, l.detalhe].filter(Boolean).join(' - ');
        }
        const chave = `${l.titulo}|${l.detalhe}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        lista.push(l);
      }
      res.json(lista.slice(0, 6));
    } catch {
      throw new ErroApi(502, 'Busca de endereços indisponível. Toque no mapa para marcar o local.');
    }
  });

  r.get('/geo/reverso', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const fallback = { titulo: 'Local marcado no mapa', detalhe: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
    fallback.endereco = `${fallback.titulo} (${fallback.detalhe})`;
    try {
      const resp = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1`, {
        headers: { 'User-Agent': 'MotoX/0.1' },
        signal: AbortSignal.timeout(5000),
      });
      const f = (await resp.json()).features?.[0];
      // mantém a coordenada exata clicada, não a do endereço encontrado
      res.json(f ? { ...formatarLugar(f), lat, lng } : fallback);
    } catch {
      res.json(fallback);
    }
  });

  // ---------- cotação e pedido (cliente) ----------

  // Calcula rota, preço (com tarifa dinâmica) e desconto. Com estrito, cupom inválido é erro;
  // sem, a cotação só avisa o motivo e segue sem desconto.
  async function orcar(b, clienteId, { estrito = false } = {}) {
    const tarifas = obterTarifas(db);
    const origem = ponto(b.origem, 'coleta');
    const destino = ponto(b.destino, 'entrega');
    const tamanho = b.tamanho || 'pequeno';
    if (!tarifas.tamanhos[tamanho]) throw new ErroApi(400, 'Tamanho de pacote inválido.');
    if (distanciaKm(origem, destino) < 0.05) throw new ErroApi(400, 'Coleta e entrega estão no mesmo lugar.');
    const rota = await calcularRota(origem, destino, { usarOsrm });
    if (rota.distanciaKm > tarifas.distanciaMaxKm) {
      throw new ErroApi(400, `Distância máxima atendida: ${tarifas.distanciaMaxKm} km.`);
    }
    const valores = calcularPreco(
      { distanciaKm: rota.distanciaKm, tamanho, idaVolta: !!b.idaVolta },
      tarifas,
      dinamicaAgora(tarifas)
    );

    // desconto: cupom digitado ou, sem ele, a melhor promoção automática (ex.: boas-vindas)
    let promo = null;
    let cupomErro = null;
    const codigo = normalizarCodigo(b.cupom);
    try {
      promo = codigo
        ? aplicarCupom(db, { codigo, clienteId, preco: valores.preco })
        : melhorAutomatica(db, { clienteId, preco: valores.preco });
    } catch (e) {
      if (!(e instanceof ErroCupom)) throw e;
      if (estrito) throw new ErroApi(400, e.message);
      cupomErro = e.message;
    }
    const desconto = promo ? promo.desconto : 0;
    return {
      origem,
      destino,
      tamanho,
      idaVolta: !!b.idaVolta,
      rota,
      ...valores,
      precoOriginal: valores.preco,
      preco: Math.round((valores.preco - desconto) * 100) / 100,
      desconto,
      promo: promo && promo.promo,
      cupomErro,
      // o desconto sai da parte da plataforma; o ganho do motoboy não muda
      taxaPlataforma: Math.round((valores.taxaPlataforma - desconto) * 100) / 100,
    };
  }

  r.post('/cotacao', autenticar, async (req, res) => {
    const o = await orcar(req.body || {}, req.usuario.id);
    const online = desp.motoboysOnline().filter((m) => distanciaKm(m, o.origem) <= desp.raioKm).length;
    res.json({
      preco: o.preco,
      precoOriginal: o.precoOriginal,
      desconto: o.desconto,
      cupom: o.promo ? { codigo: o.promo.codigo, descricao: o.promo.descricao, automatico: !!o.promo.automatica } : null,
      cupomErro: o.cupomErro,
      adicionalDinamico: o.adicionalDinamico,
      motivosDinamica: o.motivosDinamica,
      distanciaKm: o.rota.distanciaKm,
      duracaoMin: o.rota.duracaoMin,
      rota: o.rota.geometria,
      motoboysProximos: online,
    });
  });

  r.post('/corridas', autenticar, exigir('cliente'), async (req, res) => {
    const b = req.body || {};
    const pagamento = PAGAMENTOS.includes(b.pagamento) ? b.pagamento : 'pix';
    const o = await orcar(b, req.usuario.id, { estrito: true });
    // a partir daqui tudo é síncrono: checagens e gravação acontecem juntas, sem corrida entre pedidos
    const ativa = db
      .prepare(`SELECT id FROM corridas WHERE cliente_id = ? AND status IN (${ATIVOS_SQL})`)
      .get(req.usuario.id);
    if (ativa) throw new ErroApi(409, 'Você já tem uma entrega em andamento.');
    if (o.promo) {
      // revalida o cupom (limite de usos pode ter acabado durante o cálculo da rota)
      try {
        aplicarCupom(db, { codigo: o.promo.codigo, clienteId: req.usuario.id, preco: o.precoOriginal });
      } catch (e) {
        if (e instanceof ErroCupom) throw new ErroApi(409, e.message);
        throw e;
      }
    }
    const pin = String(crypto.randomInt(1000, 10000));
    const codigo = crypto.randomBytes(6).toString('hex');
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO corridas (cliente_id, status, origem_end, origem_lat, origem_lng, destino_end, destino_lat,
          destino_lng, distancia_km, duracao_min, rota_json, tamanho, ida_volta, pagamento, observacoes,
          destinatario_nome, destinatario_tel, preco, ganho_motoboy, taxa_plataforma, pin_entrega,
          codigo_rastreio, criado_em, preco_original, desconto, promocao_id, cupom, adicional_dinamico, motivo_dinamico)
         VALUES (?, 'procurando', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.usuario.id,
        o.origem.endereco,
        o.origem.lat,
        o.origem.lng,
        o.destino.endereco,
        o.destino.lat,
        o.destino.lng,
        o.rota.distanciaKm,
        o.rota.duracaoMin,
        JSON.stringify(o.rota.geometria),
        o.tamanho,
        o.idaVolta ? 1 : 0,
        pagamento,
        texto(b.observacoes, 300) || null,
        texto(b.destinatarioNome, 80) || null,
        soDigitos(b.destinatarioTel).slice(0, 11) || null,
        o.preco,
        o.ganhoMotoboy,
        o.taxaPlataforma,
        pin,
        codigo,
        Date.now(),
        o.precoOriginal,
        o.desconto,
        o.promo ? o.promo.id : null,
        o.promo ? o.promo.codigo : null,
        o.adicionalDinamico,
        o.motivosDinamica.join(' + ') || null
      );
    const id = Number(lastInsertRowid);
    desp.emitir(id);
    desp.despachar(id);
    res.status(201).json(desp.serializar(buscarCorrida(db, id), 'cliente'));
  });

  // ---------- consultas ----------

  const visaoDe = (u) => (u.tipo === 'motoboy' ? 'motoboy' : u.tipo === 'admin' ? 'admin' : 'cliente');

  function corridaDoUsuario(req) {
    const c = buscarCorrida(db, Number(req.params.id));
    const u = req.usuario;
    if (!c || (u.tipo === 'cliente' && c.cliente_id !== u.id) || (u.tipo === 'motoboy' && c.motoboy_id !== u.id)) {
      throw new ErroApi(404, 'Corrida não encontrada.');
    }
    return c;
  }

  r.get('/corridas/ativa', autenticar, (req, res) => {
    const u = req.usuario;
    if (u.tipo === 'motoboy') {
      const c = desp.corridaAtivaDoMotoboy(u.id);
      return res.json({
        corrida: c ? desp.serializar(c, 'motoboy') : null,
        oferta: desp.ofertaPendente(u.id),
      });
    }
    const c = db
      .prepare(`SELECT * FROM corridas WHERE cliente_id = ? AND status IN (${ATIVOS_SQL}) ORDER BY id DESC LIMIT 1`)
      .get(u.id);
    res.json({ corrida: c ? desp.serializar(c, 'cliente') : null });
  });

  r.get('/corridas', autenticar, (req, res) => {
    const u = req.usuario;
    const coluna = u.tipo === 'motoboy' ? 'motoboy_id' : 'cliente_id';
    const lista = db.prepare(`SELECT * FROM corridas WHERE ${coluna} = ? ORDER BY id DESC LIMIT 50`).all(u.id);
    res.json(lista.map((c) => desp.serializar(c, visaoDe(u))));
  });

  r.get('/corridas/:id', autenticar, (req, res) => {
    res.json(desp.serializar(corridaDoUsuario(req), visaoDe(req.usuario)));
  });

  // ---------- ações do cliente ----------

  r.post('/corridas/:id/cancelar', autenticar, exigir('cliente'), (req, res) => {
    const c = corridaDoUsuario(req);
    if (!['procurando', 'a_caminho_coleta', 'no_local_coleta'].includes(c.status)) {
      throw new ErroApi(409, 'Depois da coleta não é possível cancelar pelo app. Fale com o motoboy.');
    }
    db.prepare("UPDATE corridas SET status = 'cancelada', cancelado_em = ?, cancelado_por = 'cliente' WHERE id = ?").run(
      Date.now(),
      c.id
    );
    desp.cancelada(c.id);
    desp.emitir(c.id);
    res.json(desp.serializar(buscarCorrida(db, c.id), 'cliente'));
  });

  r.post('/corridas/:id/avaliar', autenticar, exigir('cliente', 'motoboy'), (req, res) => {
    const c = corridaDoUsuario(req);
    const nota = Number(req.body && req.body.nota);
    if (!Number.isInteger(nota) || nota < 1 || nota > 5) throw new ErroApi(400, 'A nota vai de 1 a 5.');
    if (c.status !== 'entregue') throw new ErroApi(409, 'Só é possível avaliar depois da entrega.');
    const ehCliente = req.usuario.tipo === 'cliente';
    const coluna = ehCliente ? 'avaliacao_do_cliente' : 'avaliacao_do_motoboy';
    const avaliadoId = ehCliente ? c.motoboy_id : c.cliente_id;
    if (c[coluna] != null) throw new ErroApi(409, 'Você já avaliou esta corrida.');
    db.prepare(`UPDATE corridas SET ${coluna} = ? WHERE id = ?`).run(nota, c.id);
    db.prepare('UPDATE usuarios SET nota_soma = nota_soma + ?, nota_qtd = nota_qtd + 1 WHERE id = ?').run(
      nota,
      avaliadoId
    );
    res.json({ ok: true });
  });

  // ---------- ações do motoboy ----------

  r.post('/corridas/:id/aceitar', autenticar, exigir('motoboy'), (req, res) => {
    const id = Number(req.params.id);
    if (req.usuario.status_cadastro !== 'aprovado') throw new ErroApi(403, 'Seu cadastro ainda não foi aprovado.');
    if (desp.corridaAtivaDoMotoboy(req.usuario.id)) throw new ErroApi(409, 'Finalize sua corrida atual primeiro.');
    try {
      desp.aceitar(req.usuario.id, id);
    } catch (e) {
      if (e instanceof ErroDespacho) throw new ErroApi(409, e.message);
      throw e;
    }
    res.json(desp.serializar(buscarCorrida(db, id), 'motoboy'));
  });

  r.post('/corridas/:id/recusar', autenticar, exigir('motoboy'), (req, res) => {
    desp.recusar(req.usuario.id, Number(req.params.id));
    res.json({ ok: true });
  });

  // Transições de status do motoboy: [status atual permitido] -> novo status
  const transicao = (acao, de, para, coluna, validar) =>
    r.post(`/corridas/:id/${acao}`, autenticar, exigir('motoboy'), (req, res) => {
      const c = corridaDoUsuario(req);
      if (!de.includes(c.status)) throw new ErroApi(409, 'Ação não permitida nesta etapa da corrida.');
      if (validar) validar(c, req.body || {});
      const novo = typeof para === 'function' ? para(c) : para;
      db.prepare(`UPDATE corridas SET status = ?, ${coluna} = ? WHERE id = ?`).run(novo, Date.now(), c.id);
      desp.emitir(c.id);
      res.json(desp.serializar(buscarCorrida(db, c.id), 'motoboy'));
    });

  transicao('chegou', ['a_caminho_coleta'], 'no_local_coleta', 'chegou_coleta_em');
  transicao('coletar', ['a_caminho_coleta', 'no_local_coleta'], 'em_rota', 'coletado_em');
  transicao(
    'entregar',
    ['em_rota'],
    (c) => (c.ida_volta ? 'retornando' : 'entregue'),
    'entregue_em',
    (c, b) => {
      if (String(b.pin || '').trim() !== c.pin_entrega) {
        throw new ErroApi(400, 'Código de entrega incorreto. Peça o código de 4 dígitos ao destinatário.');
      }
    }
  );
  transicao('finalizar', ['retornando'], 'entregue', 'finalizado_em');

  r.post('/corridas/:id/desistir', autenticar, exigir('motoboy'), (req, res) => {
    const c = corridaDoUsuario(req);
    if (!['a_caminho_coleta', 'no_local_coleta'].includes(c.status)) {
      throw new ErroApi(409, 'Depois da coleta não é possível desistir.');
    }
    db.prepare(
      "UPDATE corridas SET status = 'procurando', motoboy_id = NULL, aceito_em = NULL, chegou_coleta_em = NULL WHERE id = ?"
    ).run(c.id);
    desp.devolverParaFila(c.id, req.usuario.id);
    res.json({ ok: true });
  });

  // ---------- documentos do motoboy ----------

  r.get('/motoboy/documentos', autenticar, exigir('motoboy'), (req, res) => {
    res.json({
      statusCadastro: req.usuario.status_cadastro,
      motivoReprovacao: req.usuario.motivo_reprovacao,
      documentos: documentosAtuais(db, req.usuario.id),
    });
  });

  // Reenvio após reprovação (ou complemento enquanto está em análise): volta para a fila do admin
  r.post('/motoboy/documentos', autenticar, exigir('motoboy'), (req, res) => {
    if (req.usuario.status_cadastro === 'aprovado') {
      throw new ErroApi(409, 'Seu cadastro já está aprovado. Para trocar documentos, fale com o suporte.');
    }
    const docs = comoErroDoc(() => validarDocumentos((req.body || {}).documentos, []));
    gravarDocumentos(db, pastaDocumentos, req.usuario.id, docs);
    db.prepare("UPDATE usuarios SET status_cadastro = 'pendente', motivo_reprovacao = NULL WHERE id = ?").run(req.usuario.id);
    desp.io.to('admin').emit('cadastro:pendente', { id: req.usuario.id, reenvio: true });
    res.json({ statusCadastro: 'pendente', documentos: documentosAtuais(db, req.usuario.id) });
  });

  r.get('/motoboy/resumo', autenticar, exigir('motoboy'), (req, res) => {
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(inicioDia);
    inicioSemana.setDate(inicioDia.getDate() - inicioDia.getDay());
    const soma = db.prepare(
      "SELECT COUNT(*) AS qtd, COALESCE(SUM(ganho_motoboy), 0) AS total FROM corridas WHERE motoboy_id = ? AND status = 'entregue' AND entregue_em >= ?"
    );
    res.json({
      hoje: soma.get(req.usuario.id, inicioDia.getTime()),
      semana: soma.get(req.usuario.id, inicioSemana.getTime()),
      nota: usuarioPublico(req.usuario).nota,
    });
  });

  // ---------- rastreio público (destinatário) ----------

  r.get('/rastreio/:codigo', (req, res) => {
    const c = db.prepare('SELECT * FROM corridas WHERE codigo_rastreio = ?').get(String(req.params.codigo));
    if (!c) throw new ErroApi(404, 'Código de rastreio não encontrado.');
    res.json(desp.serializar(c, 'publico'));
  });

  // ---------- painel administrativo ----------

  r.get('/admin/resumo', autenticar, exigir('admin'), (req, res) => {
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);
    const hoje = db
      .prepare(
        `SELECT COUNT(*) AS pedidos,
                SUM(status = 'entregue') AS entregues,
                SUM(status IN ('cancelada','expirada')) AS perdidas,
                COALESCE(SUM(CASE WHEN status = 'entregue' THEN preco END), 0) AS faturamento,
                COALESCE(SUM(CASE WHEN status = 'entregue' THEN taxa_plataforma END), 0) AS receita,
                COALESCE(SUM(CASE WHEN status = 'entregue' THEN desconto END), 0) AS descontos
         FROM corridas WHERE criado_em >= ?`
      )
      .get(inicioDia.getTime());
    const andamento = db.prepare(`SELECT COUNT(*) AS n FROM corridas WHERE status IN (${ATIVOS_SQL})`).get().n;
    const cadastrosPendentes = db
      .prepare("SELECT COUNT(*) AS n FROM usuarios WHERE tipo = 'motoboy' AND status_cadastro = 'pendente' AND excluido_em IS NULL")
      .get().n;
    const totais = db.prepare('SELECT tipo, COUNT(*) AS n FROM usuarios WHERE excluido_em IS NULL GROUP BY tipo').all();
    const online = desp.motoboysOnline().map((m) => ({ ...m, nome: buscarUsuario(db, m.id)?.nome }));
    const corridas = db.prepare('SELECT * FROM corridas ORDER BY id DESC LIMIT 30').all();
    const tarifas = obterTarifas(db);
    res.json({
      hoje,
      andamento,
      dinamica: dinamicaAgora(tarifas),
      cadastrosPendentes,
      usuarios: Object.fromEntries(totais.map((t) => [t.tipo, t.n])),
      online,
      corridas: corridas.map((c) => desp.serializar(c, 'admin')),
    });
  });

  // ---------- tarifas (admin) ----------

  const comoErroApi = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ErroTarifa || e instanceof ErroCupom) throw new ErroApi(400, e.message);
      throw e;
    }
  };

  r.get('/admin/tarifas', autenticar, exigir('admin'), (req, res) => {
    const tarifas = obterTarifas(db);
    res.json({ tarifas, padrao: PADRAO, agora: dinamicaAgora(tarifas), alteracao: infoAlteracao(db) });
  });

  r.post('/admin/tarifas', autenticar, exigir('admin'), (req, res) => {
    const tarifas = comoErroApi(() => salvarTarifas(db, req.body && req.body.tarifas, req.usuario.id));
    res.json({ tarifas, agora: dinamicaAgora(tarifas), alteracao: infoAlteracao(db) });
  });

  // Simula com as tarifas ainda não salvas do formulário, para o admin ver o efeito antes de aplicar
  r.post('/admin/tarifas/simular', autenticar, exigir('admin'), (req, res) => {
    const b = req.body || {};
    const tarifas = comoErroApi(() => validarTarifas(b.tarifas));
    const km = Number(b.distanciaKm);
    if (!Number.isFinite(km) || km <= 0 || km > 300) throw new ErroApi(400, 'Distância da simulação inválida.');
    const tamanho = tarifas.tamanhos[b.tamanho] ? b.tamanho : 'pequeno';
    const dinamica = b.comDinamica ? dinamicaAgora(tarifas) : null;
    res.json(calcularPreco({ distanciaKm: km, tamanho, idaVolta: !!b.idaVolta }, tarifas, dinamica));
  });

  // ---------- promoções (admin) ----------

  r.get('/admin/promocoes', autenticar, exigir('admin'), (req, res) => {
    const lista = db.prepare('SELECT * FROM promocoes ORDER BY id DESC').all();
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);
    const mes = db
      .prepare(
        `SELECT COUNT(*) AS corridas, COALESCE(SUM(desconto), 0) AS total FROM corridas
         WHERE promocao_id IS NOT NULL AND status NOT IN ('cancelada','expirada') AND criado_em >= ?`
      )
      .get(inicioMes.getTime());
    res.json({ promocoes: lista.map((p) => serializarPromocao(db, p)), mes });
  });

  function gravarPromocao(req, id = null) {
    const p = comoErroApi(() => validarPromocao(req.body || {}));
    const repetido = db.prepare('SELECT id FROM promocoes WHERE codigo = ? AND id IS NOT ?').get(p.codigo, id);
    if (repetido) throw new ErroApi(409, `Já existe uma promoção com o código ${p.codigo}.`);
    const colunas = Object.keys(p);
    if (id) {
      db.prepare(`UPDATE promocoes SET ${colunas.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(p), id);
      return id;
    }
    const r2 = db
      .prepare(`INSERT INTO promocoes (${colunas.join(', ')}, criado_em) VALUES (${colunas.map(() => '?').join(', ')}, ?)`)
      .run(...Object.values(p), Date.now());
    return Number(r2.lastInsertRowid);
  }

  const promocaoOu404 = (id) => {
    const p = db.prepare('SELECT * FROM promocoes WHERE id = ?').get(id);
    if (!p) throw new ErroApi(404, 'Promoção não encontrada.');
    return p;
  };

  r.post('/admin/promocoes', autenticar, exigir('admin'), (req, res) => {
    const id = gravarPromocao(req);
    res.status(201).json(serializarPromocao(db, promocaoOu404(id)));
  });

  r.post('/admin/promocoes/:id', autenticar, exigir('admin'), (req, res) => {
    const id = promocaoOu404(Number(req.params.id)).id;
    gravarPromocao(req, id);
    res.json(serializarPromocao(db, promocaoOu404(id)));
  });

  r.post('/admin/promocoes/:id/ativo', autenticar, exigir('admin'), (req, res) => {
    const p = promocaoOu404(Number(req.params.id));
    db.prepare('UPDATE promocoes SET ativo = ? WHERE id = ?').run(req.body && req.body.ativo ? 1 : 0, p.id);
    res.json(serializarPromocao(db, promocaoOu404(p.id)));
  });

  // Promoção já usada não é apagada (as corridas apontam para ela): pause-a
  r.delete('/admin/promocoes/:id', autenticar, exigir('admin'), (req, res) => {
    const p = promocaoOu404(Number(req.params.id));
    if (db.prepare('SELECT 1 FROM corridas WHERE promocao_id = ?').get(p.id)) {
      throw new ErroApi(409, 'Esta promoção já foi usada e fica no histórico. Pause-a em vez de excluir.');
    }
    db.prepare('DELETE FROM promocoes WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  // ---------- análise de cadastro de motoboy (admin) ----------

  // O arquivo só sai por aqui, com login de admin; nunca por um endereço público
  r.get('/admin/documentos/:id', autenticar, exigir('admin'), (req, res) => {
    const d = caminhoDocumento(db, pastaDocumentos, Number(req.params.id));
    if (!d || !fs.existsSync(d.completo)) throw new ErroApi(404, 'Documento não encontrado.');
    res.set({
      'Content-Type': d.mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${d.tipo}-${d.usuario_id}.${d.arquivo.split('.').pop()}"`,
    });
    res.sendFile(d.completo);
  });

  r.post('/admin/usuarios/:id/analise', autenticar, exigir('admin'), (req, res) => {
    const u = buscarUsuario(db, Number(req.params.id));
    if (!u || u.excluido_em || u.tipo !== 'motoboy') throw new ErroApi(404, 'Motoboy não encontrado.');
    const aprovar = !!(req.body && req.body.aprovar);
    const motivo = texto(req.body && req.body.motivo, 300);
    if (!aprovar && motivo.length < 3) throw new ErroApi(400, 'Explique o motivo da reprovação: o motoboy vai ler.');
    if (aprovar && documentosAtuais(db, u.id).length < 2) {
      throw new ErroApi(409, 'Este motoboy ainda não enviou a CNH e o documento da moto.');
    }
    db.prepare('UPDATE usuarios SET status_cadastro = ?, motivo_reprovacao = ?, analisado_em = ? WHERE id = ?').run(
      aprovar ? 'aprovado' : 'reprovado',
      aprovar ? null : motivo,
      Date.now(),
      u.id
    );
    if (!aprovar) desp.definirOnline(u.id, false); // por segurança, caso estivesse online
    // avisa o app do motoboy na hora
    desp.io.to(`usuario:${u.id}`).emit('conta:cadastro', { statusCadastro: aprovar ? 'aprovado' : 'reprovado', motivoReprovacao: aprovar ? null : motivo });
    res.json(usuarioPublico(buscarUsuario(db, u.id)));
  });

  // ---------- gestão de contas (admin) ----------

  r.get('/admin/usuarios', autenticar, exigir('admin'), (req, res) => {
    const tipo = ['cliente', 'motoboy', 'admin'].includes(req.query.tipo) ? req.query.tipo : null;
    const q = texto(req.query.q, 80);
    const filtros = ['u.excluido_em IS NULL'];
    const params = [];
    if (tipo) {
      filtros.push('u.tipo = ?');
      params.push(tipo);
    }
    if (['pendente', 'reprovado'].includes(req.query.cadastro)) {
      filtros.push('u.status_cadastro = ?');
      params.push(req.query.cadastro);
    }
    if (q) {
      filtros.push("(u.nome LIKE ? OR u.telefone LIKE ? OR IFNULL(u.placa, '') LIKE ?)");
      const like = `%${q.replace(/[%_]/g, '')}%`;
      params.push(like, `%${soDigitos(q) || q}%`, like.toUpperCase());
    }
    const lista = db
      .prepare(
        `SELECT u.*,
                (SELECT COUNT(*) FROM corridas c WHERE c.cliente_id = u.id OR c.motoboy_id = u.id) AS total_corridas,
                (SELECT MAX(c.criado_em) FROM corridas c WHERE c.cliente_id = u.id OR c.motoboy_id = u.id) AS ultima_corrida
         FROM usuarios u WHERE ${filtros.join(' AND ')}
         ORDER BY u.id DESC LIMIT 200`
      )
      .all(...params);
    const online = new Set(desp.motoboysOnline().map((m) => m.id));
    res.json(
      lista.map((u) => ({
        ...usuarioPublico(u),
        criadoEm: u.criado_em,
        bloqueado: !!u.bloqueado,
        online: online.has(u.id),
        totalCorridas: u.total_corridas,
        documentos: u.tipo === 'motoboy' ? documentosAtuais(db, u.id) : [],
        ultimaCorrida: u.ultima_corrida,
      }))
    );
  });

  // Conta que pode ser alterada pelo admin: existe, não foi excluída, não é admin e não está em corrida
  function contaGerenciavel(id) {
    const u = buscarUsuario(db, id);
    if (!u || u.excluido_em) throw new ErroApi(404, 'Conta não encontrada.');
    if (u.tipo === 'admin') throw new ErroApi(403, 'Contas de administrador não podem ser alteradas aqui.');
    const ativa = db
      .prepare(`SELECT id FROM corridas WHERE (cliente_id = ? OR motoboy_id = ?) AND status IN (${ATIVOS_SQL})`)
      .get(id, id);
    if (ativa) throw new ErroApi(409, `Esta conta tem a corrida #${ativa.id} em andamento. Aguarde terminar ou cancele.`);
    return u;
  }

  r.post('/admin/usuarios/:id/bloquear', autenticar, exigir('admin'), (req, res) => {
    const u = contaGerenciavel(Number(req.params.id));
    const bloquear = !!(req.body && req.body.bloqueado);
    db.prepare('UPDATE usuarios SET bloqueado = ? WHERE id = ?').run(bloquear ? 1 : 0, u.id);
    if (bloquear) {
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
      desp.encerrarAcesso(u.id);
    }
    res.json({ ok: true, bloqueado: bloquear });
  });

  // Sem corridas: apaga de vez. Com histórico: remove os dados pessoais e mantém as
  // corridas (necessárias para faturamento e repasses). O telefone fica livre para novo cadastro.
  r.delete('/admin/usuarios/:id', autenticar, exigir('admin'), (req, res) => {
    const u = contaGerenciavel(Number(req.params.id));
    const temHistorico = db.prepare('SELECT 1 FROM corridas WHERE cliente_id = ? OR motoboy_id = ?').get(u.id, u.id);
    desp.encerrarAcesso(u.id);
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(u.id);
    apagarDocumentos(db, pastaDocumentos, u.id);
    if (temHistorico) {
      db.prepare(
        `UPDATE usuarios SET nome = 'Conta excluída', telefone = ?, senha_hash = '', placa = NULL, moto = NULL,
                bloqueado = 1, excluido_em = ? WHERE id = ?`
      ).run(`excluido-${u.id}`, Date.now(), u.id);
    } else {
      db.prepare('DELETE FROM usuarios WHERE id = ?').run(u.id);
    }
    res.json({ ok: true, modo: temHistorico ? 'anonimizada' : 'apagada' });
  });

  // ---------- erros ----------

  r.use((req, res, next) => next(new ErroApi(404, 'Rota não encontrada.')));
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof ErroApi) return res.status(err.status).json({ erro: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
    console.error(err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  });

  return r;
}

module.exports = { criarRotas };
