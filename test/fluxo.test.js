const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
// apoio primeiro: define as credenciais de teste antes de qualquer módulo ler a configuração
const { PAULISTA, PINHEIROS, PERTO, MEDIO, LONGE, iniciar, api, registrar, socket, conectar, esperar, emitirAck, pausa } = require('./apoio');
const { calcularPreco } = require('../server/precos');

describe('preços', () => {
  test('aplica mínimo, tamanho, ida e volta e divide 85/15', () => {
    assert.equal(calcularPreco({ distanciaKm: 0.5 }).preco, 10); // mínimo
    const p = calcularPreco({ distanciaKm: 10 }); // 7 + 19 = 26
    assert.equal(p.preco, 26);
    assert.equal(p.ganhoMotoboy, 22.1);
    assert.equal(p.taxaPlataforma, 3.9);
    assert.equal(calcularPreco({ distanciaKm: 10, tamanho: 'grande' }).preco, 42); // 41,60 arredonda p/ 42,00
    assert.equal(calcularPreco({ distanciaKm: 10, idaVolta: true }).preco, 44.5); // 26 * 1.7 = 44.2 -> 44.5
    assert.throws(() => calcularPreco({ distanciaKm: 1, tamanho: 'gigante' }));
  });
});

describe('autenticação', () => {
  let ctx;
  before(async () => (ctx = await iniciar()));
  after(() => ctx.fechar());

  test('valida cadastro, impede duplicado e faz login', async () => {
    let r = await api(ctx, 'POST', '/auth/registrar', { nome: 'A', telefone: '1', senha: '1', tipo: 'cliente' });
    assert.equal(r.status, 400);
    r = await api(ctx, 'POST', '/auth/registrar', {
      nome: 'Moto Sem Placa', telefone: '11988887777', senha: 'segredo1', tipo: 'motoboy', placa: 'XX', moto: 'CG',
    });
    assert.equal(r.status, 400);
    assert.match(r.dados.erro, /Placa/);

    r = await api(ctx, 'POST', '/auth/registrar', {
      nome: 'Maria', telefone: '(11) 97777-6666', senha: 'segredo1', tipo: 'cliente',
    });
    assert.equal(r.status, 201);
    assert.equal(r.dados.usuario.telefone, '11977776666');

    r = await api(ctx, 'POST', '/auth/registrar', { nome: 'Maria', telefone: '11977776666', senha: 'segredo1', tipo: 'cliente' });
    assert.equal(r.status, 409);

    r = await api(ctx, 'POST', '/auth/login', { telefone: '11977776666', senha: 'errada' });
    assert.equal(r.status, 401);
    r = await api(ctx, 'POST', '/auth/login', { telefone: '11977776666', senha: 'segredo1' });
    assert.equal(r.status, 200);
    const eu = await api(ctx, 'GET', '/eu', null, r.dados.token);
    assert.equal(eu.dados.nome, 'Maria');

    assert.equal((await api(ctx, 'GET', '/eu', null, 'token-falso')).status, 401);
  });

  test('admin padrão existe e só ele acessa o painel', async () => {
    const r = await api(ctx, 'POST', '/auth/login', { telefone: '11900000000', senha: 'admin-teste' });
    assert.equal(r.dados.usuario.tipo, 'admin');
    assert.equal((await api(ctx, 'GET', '/admin/resumo', null, r.dados.token)).status, 200);
    const cli = await registrar(ctx, 'cliente');
    assert.equal((await api(ctx, 'GET', '/admin/resumo', null, cli)).status, 403);
  });
});

describe('fluxo completo de entrega', () => {
  let ctx, cliente, sCliente, mbPerto, mbMedio, mbLonge, sPerto, sMedio, sLonge;

  before(async () => {
    ctx = await iniciar({ tempoOfertaMs: 1500 });
    cliente = await registrar(ctx, 'cliente', { nome: 'Ana Souza' });
    mbPerto = await registrar(ctx, 'motoboy', { nome: 'Carlos Perto' });
    mbMedio = await registrar(ctx, 'motoboy', { nome: 'Bruno Medio' });
    mbLonge = await registrar(ctx, 'motoboy', { nome: 'Davi Longe' });
    sCliente = await socket(ctx, cliente);
    [sPerto, sMedio, sLonge] = await Promise.all([socket(ctx, mbPerto), socket(ctx, mbMedio), socket(ctx, mbLonge)]);
    assert.deepEqual(await emitirAck(sPerto, 'motoboy:status', { online: true, ...PERTO }), { ok: true, online: true });
    await emitirAck(sMedio, 'motoboy:status', { online: true, ...MEDIO });
    await emitirAck(sLonge, 'motoboy:status', { online: true, ...LONGE });
  });

  after(async () => {
    for (const s of [sCliente, sPerto, sMedio, sLonge]) s.disconnect();
    await ctx.fechar();
  });

  let corrida;

  test('cotação mostra preço e motoboys próximos (o distante não conta)', async () => {
    const r = await api(ctx, 'POST', '/cotacao', { origem: PAULISTA, destino: PINHEIROS }, cliente);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.ok(r.dados.preco >= 10);
    assert.equal(r.dados.motoboysProximos, 2);
  });

  test('motoboy não pode pedir corrida', async () => {
    const r = await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS }, mbPerto);
    assert.equal(r.status, 403);
    assert.equal(r.dados.erro, 'Esta ação é só para clientes. Você está conectado como motoboy.');
  });

  test('pedido vai primeiro para o motoboy mais próximo, com ganho transparente e sem PIN', async () => {
    const ofertaPerto = esperar(sPerto, 'oferta');
    const r = await api(
      ctx,
      'POST',
      '/corridas',
      {
        origem: PAULISTA,
        destino: PINHEIROS,
        tamanho: 'medio',
        pagamento: 'pix',
        destinatarioNome: 'João',
        destinatarioTel: '11955554444',
        observacoes: 'Portaria',
      },
      cliente
    );
    assert.equal(r.status, 201, JSON.stringify(r.dados));
    corrida = r.dados;
    assert.equal(corrida.status, 'procurando');
    assert.match(corrida.pin, /^\d{4}$/);

    const o = await ofertaPerto;
    assert.equal(o.corrida.id, corrida.id);
    assert.ok(o.distanciaAteColetaKm < 0.5);
    assert.ok(o.corrida.ganhoMotoboy > 0 && o.corrida.ganhoMotoboy < corrida.preco);
    assert.equal(o.corrida.pin, undefined, 'motoboy nunca recebe o PIN');

    const segundo = await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS }, cliente);
    assert.equal(segundo.status, 409, 'só uma corrida ativa por cliente');
  });

  test('recusa passa a oferta ao próximo; quem recusou não pode aceitar', async () => {
    const ofertaMedio = esperar(sMedio, 'oferta');
    await api(ctx, 'POST', `/corridas/${corrida.id}/recusar`, {}, mbPerto);
    const o = await ofertaMedio;
    assert.equal(o.corrida.id, corrida.id);
    const r = await api(ctx, 'POST', `/corridas/${corrida.id}/aceitar`, {}, mbPerto);
    assert.equal(r.status, 409);
  });

  test('tempo esgotado sem resposta: oferta expira (e não vai para quem está fora do raio)', async () => {
    const expirou = await esperar(sMedio, 'oferta:expirada');
    assert.equal(expirou.corridaId, corrida.id);
    const ativa = await api(ctx, 'GET', '/corridas/ativa', null, cliente);
    assert.equal(ativa.dados.corrida.status, 'procurando');
  });

  test('motoboy que fica online recebe a corrida pendente e aceita', async () => {
    const novo = await registrar(ctx, 'motoboy', { nome: 'Eva Nova' });
    const s = await socket(ctx, novo);
    const oferta = esperar(s, 'oferta');
    await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    await oferta;

    const atualizacao = esperar(sCliente, 'corrida', (c) => c.status === 'a_caminho_coleta');
    const r = await api(ctx, 'POST', `/corridas/${corrida.id}/aceitar`, {}, novo);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    const c = await atualizacao;
    assert.equal(c.motoboy.nome, 'Eva Nova');
    assert.equal(c.motoboy.placa.length, 7);
    assert.ok(c.motoboy.telefone);

    ctx.mbNovo = novo;
    ctx.sNovo = s;
  });

  test('localização do motoboy chega ao cliente e ao rastreio público (sem dados sensíveis)', async () => {
    const pub = await socket(ctx, undefined);
    const ack = await emitirAck(pub, 'rastrear', corrida.codigoRastreio);
    assert.equal(ack.corrida.status, 'a_caminho_coleta');
    assert.equal(ack.corrida.pin, undefined);
    assert.equal(ack.corrida.preco, undefined);
    assert.equal(ack.corrida.motoboy.nome, 'Eva');
    assert.equal(ack.corrida.motoboy.telefone, undefined);

    const noCliente = esperar(sCliente, 'local');
    const noPublico = esperar(pub, 'local');
    ctx.sNovo.emit('motoboy:local', { lat: -23.5615, lng: -46.656 });
    assert.equal((await noCliente).lat, -23.5615);
    assert.equal((await noPublico).corridaId, corrida.id);
    pub.disconnect();

    const http = await api(ctx, 'GET', `/rastreio/${corrida.codigoRastreio}`);
    assert.equal(http.status, 200);
    assert.equal(http.dados.pin, undefined);
  });

  test('etapas: chegou -> coletou -> PIN errado bloqueia -> PIN certo entrega', async () => {
    const mb = ctx.mbNovo;
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/entregar`, { pin: corrida.pin }, mb)).status, 409);
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/chegou`, {}, mb)).dados.status, 'no_local_coleta');
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/coletar`, {}, mb)).dados.status, 'em_rota');

    const cancel = await api(ctx, 'POST', `/corridas/${corrida.id}/cancelar`, {}, cliente);
    assert.equal(cancel.status, 409, 'não cancela depois da coleta');

    const errado = await api(ctx, 'POST', `/corridas/${corrida.id}/entregar`, { pin: '0000' === corrida.pin ? '1111' : '0000' }, mb);
    assert.equal(errado.status, 400);

    const entregue = esperar(sCliente, 'corrida', (c) => c.status === 'entregue');
    const ok = await api(ctx, 'POST', `/corridas/${corrida.id}/entregar`, { pin: corrida.pin }, mb);
    assert.equal(ok.dados.status, 'entregue');
    await entregue;
  });

  test('avaliações dos dois lados, uma vez só, e ganhos do dia', async () => {
    const mb = ctx.mbNovo;
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/avaliar`, { nota: 5 }, cliente)).status, 200);
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/avaliar`, { nota: 1 }, cliente)).status, 409);
    assert.equal((await api(ctx, 'POST', `/corridas/${corrida.id}/avaliar`, { nota: 4 }, mb)).status, 200);

    const resumo = await api(ctx, 'GET', '/motoboy/resumo', null, mb);
    assert.equal(resumo.dados.hoje.qtd, 1);
    assert.ok(resumo.dados.hoje.total > 0);
    assert.equal(resumo.dados.nota, 5);

    const outro = await api(ctx, 'GET', `/corridas/${corrida.id}`, null, mbPerto);
    assert.equal(outro.status, 404, 'motoboy não vê corrida de outro');
    ctx.sNovo.disconnect();
  });
});

describe('cancelamento, desistência e expiração', () => {
  let ctx;
  before(async () => (ctx = await iniciar({ tempoOfertaMs: 5000, tempoMaxBuscaMs: 300 })));
  after(() => ctx.fechar());

  test('motoboy desiste antes da coleta: corrida volta para a fila', async () => {
    const cli = await registrar(ctx, 'cliente');
    const a = await registrar(ctx, 'motoboy');
    const b = await registrar(ctx, 'motoboy');
    const sa = await socket(ctx, a);
    const sb = await socket(ctx, b);
    const oa = esperar(sa, 'oferta');
    await emitirAck(sa, 'motoboy:status', { online: true, ...PERTO });
    await emitirAck(sb, 'motoboy:status', { online: true, ...MEDIO });

    const c = (await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS }, cli)).dados;
    await oa;
    await api(ctx, 'POST', `/corridas/${c.id}/aceitar`, {}, a);

    const ob = esperar(sb, 'oferta');
    assert.equal((await api(ctx, 'POST', `/corridas/${c.id}/desistir`, {}, a)).status, 200);
    assert.equal((await ob).corrida.id, c.id);

    const canceladaNoMotoboy = esperar(sb, 'oferta:cancelada');
    const r = await api(ctx, 'POST', `/corridas/${c.id}/cancelar`, {}, cli);
    assert.equal(r.dados.status, 'cancelada');
    await canceladaNoMotoboy;
    sa.disconnect();
    sb.disconnect();
  });

  test('sem motoboy disponível a corrida expira', async () => {
    const cli = await registrar(ctx, 'cliente');
    const s = await socket(ctx, cli);
    const c = (await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS }, cli)).dados;
    const expirada = esperar(s, 'corrida', (x) => x.status === 'expirada');
    await pausa(350);
    ctx.desp.varrer();
    assert.equal((await expirada).id, c.id);
    s.disconnect();
  });

  test('ida e volta passa por "retornando" antes de concluir', async () => {
    const cli = await registrar(ctx, 'cliente');
    const mb = await registrar(ctx, 'motoboy');
    const s = await socket(ctx, mb);
    const of = esperar(s, 'oferta');
    await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    const c = (await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS, idaVolta: true }, cli)).dados;
    assert.equal(c.idaVolta, true);
    await of;
    await api(ctx, 'POST', `/corridas/${c.id}/aceitar`, {}, mb);
    await api(ctx, 'POST', `/corridas/${c.id}/coletar`, {}, mb);
    const r = await api(ctx, 'POST', `/corridas/${c.id}/entregar`, { pin: c.pin }, mb);
    assert.equal(r.dados.status, 'retornando');
    assert.equal((await api(ctx, 'POST', `/corridas/${c.id}/finalizar`, {}, mb)).dados.status, 'entregue');
    s.disconnect();
  });
});

describe('gestão de contas pelo admin', () => {
  let ctx, admin;
  before(async () => {
    ctx = await iniciar({ tempoOfertaMs: 5000 });
    admin = (await api(ctx, 'POST', '/auth/login', { telefone: '11900000000', senha: 'admin-teste' })).dados.token;
  });
  after(() => ctx.fechar());

  test('lista, filtra e busca contas; só admin acessa', async () => {
    const cli = await registrar(ctx, 'cliente', { nome: 'Zuleica Busca' });
    await registrar(ctx, 'motoboy');
    const todos = (await api(ctx, 'GET', '/admin/usuarios', null, admin)).dados;
    assert.ok(todos.some((u) => u.tipo === 'cliente') && todos.some((u) => u.tipo === 'motoboy'));
    const motoboys = (await api(ctx, 'GET', '/admin/usuarios?tipo=motoboy', null, admin)).dados;
    assert.ok(motoboys.length && motoboys.every((u) => u.tipo === 'motoboy'));
    const busca = (await api(ctx, 'GET', '/admin/usuarios?q=zuleica', null, admin)).dados;
    assert.deepEqual(busca.map((u) => u.nome), ['Zuleica Busca']);
    assert.equal((await api(ctx, 'GET', '/admin/usuarios', null, cli)).status, 403);
  });

  test('bloquear derruba a sessão e impede login; desbloquear libera', async () => {
    const tel = '11977000001';
    const cli = (await api(ctx, 'POST', '/auth/registrar', { nome: 'Bia Bloq', telefone: tel, senha: 'segredo1', tipo: 'cliente' })).dados;
    const s = await socket(ctx, cli.token);
    const avisado = esperar(s, 'conta:encerrada');
    assert.equal((await api(ctx, 'POST', `/admin/usuarios/${cli.usuario.id}/bloquear`, { bloqueado: true }, admin)).status, 200);
    await avisado;
    assert.equal((await api(ctx, 'GET', '/eu', null, cli.token)).status, 401);
    const login = await api(ctx, 'POST', '/auth/login', { telefone: tel, senha: 'segredo1' });
    assert.equal(login.status, 403);
    assert.match(login.dados.erro, /bloqueada/);
    await api(ctx, 'POST', `/admin/usuarios/${cli.usuario.id}/bloquear`, { bloqueado: false }, admin);
    assert.equal((await api(ctx, 'POST', '/auth/login', { telefone: tel, senha: 'segredo1' })).status, 200);
    s.disconnect();
  });

  test('motoboy bloqueado sai da fila e não recebe ofertas', async () => {
    const cli = await registrar(ctx, 'cliente');
    const mb = await registrar(ctx, 'motoboy');
    const s = await socket(ctx, mb);
    await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    const id = (await api(ctx, 'GET', '/eu', null, mb)).dados.id;
    await api(ctx, 'POST', `/admin/usuarios/${id}/bloquear`, { bloqueado: true }, admin);
    const cot = await api(ctx, 'POST', '/cotacao', { origem: PAULISTA, destino: PINHEIROS }, cli);
    assert.equal(cot.dados.motoboysProximos, 0);
  });

  test('excluir: sem histórico apaga; com histórico anonimiza e libera o telefone', async () => {
    const tel = '11977000002';
    const semHist = (await api(ctx, 'POST', '/auth/registrar', { nome: 'Caio Sem', telefone: tel, senha: 'segredo1', tipo: 'cliente' })).dados;
    let r = await api(ctx, 'DELETE', `/admin/usuarios/${semHist.usuario.id}`, null, admin);
    assert.equal(r.dados.modo, 'apagada');
    assert.equal((await api(ctx, 'GET', '/eu', null, semHist.token)).status, 401);

    // conta com corrida concluída
    const cli = (await api(ctx, 'POST', '/auth/registrar', { nome: 'Dora Hist', telefone: tel, senha: 'segredo1', tipo: 'cliente' })).dados;
    assert.ok(cli.token, 'telefone de conta apagada pode ser reutilizado');
    const mb = await registrar(ctx, 'motoboy');
    const s = await socket(ctx, mb);
    const of = esperar(s, 'oferta');
    await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    const c = (await api(ctx, 'POST', '/corridas', { origem: PAULISTA, destino: PINHEIROS }, cli.token)).dados;
    await of;
    await api(ctx, 'POST', `/corridas/${c.id}/aceitar`, {}, mb);

    r = await api(ctx, 'DELETE', `/admin/usuarios/${cli.usuario.id}`, null, admin);
    assert.equal(r.status, 409, 'não exclui com corrida em andamento');
    assert.match(r.dados.erro, /em andamento/);

    await api(ctx, 'POST', `/corridas/${c.id}/coletar`, {}, mb);
    await api(ctx, 'POST', `/corridas/${c.id}/entregar`, { pin: c.pin }, mb);
    r = await api(ctx, 'DELETE', `/admin/usuarios/${cli.usuario.id}`, null, admin);
    assert.equal(r.dados.modo, 'anonimizada');

    const lista = (await api(ctx, 'GET', '/admin/usuarios', null, admin)).dados;
    assert.ok(!lista.some((u) => u.id === cli.usuario.id), 'excluída some da lista');
    const resumo = (await api(ctx, 'GET', '/admin/resumo', null, admin)).dados;
    const corrida = resumo.corridas.find((x) => x.id === c.id);
    assert.equal(corrida.cliente.nome, 'Conta excluída');
    assert.equal(corrida.status, 'entregue');
    assert.equal((await api(ctx, 'POST', '/auth/registrar', { nome: 'Novo', telefone: tel, senha: 'segredo1', tipo: 'cliente' })).status, 201);
    s.disconnect();
  });

  test('admin não pode ser excluído nem bloqueado', async () => {
    const eu = (await api(ctx, 'GET', '/eu', null, admin)).dados;
    assert.equal((await api(ctx, 'DELETE', `/admin/usuarios/${eu.id}`, null, admin)).status, 403);
    assert.equal((await api(ctx, 'POST', `/admin/usuarios/${eu.id}/bloquear`, { bloqueado: true }, admin)).status, 403);
    assert.equal((await api(ctx, 'DELETE', '/admin/usuarios/99999', null, admin)).status, 404);
  });
});

describe('acesso pelos apps (Capacitor)', () => {
  let ctx;
  before(async () => (ctx = await iniciar()));
  after(() => ctx.fechar());

  test('libera a origem dos apps e não libera sites desconhecidos', async () => {
    for (const origem of ['http://localhost', 'https://localhost', 'capacitor://localhost']) {
      const r = await fetch(ctx.base + '/api/auth/login', {
        method: 'OPTIONS',
        headers: { Origin: origem, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), origem);
      assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
    }
    const intruso = await fetch(ctx.base + '/api/config', { headers: { Origin: 'https://site-malicioso.com' } });
    assert.equal(intruso.headers.get('access-control-allow-origin'), null);
  });

  test('socket aceita conexão vinda do app', async () => {
    const tok = await registrar(ctx, 'cliente');
    const s = conectar(ctx.base, { auth: { token: tok }, transports: ['polling'], extraHeaders: { Origin: 'https://localhost' }, forceNew: true });
    await new Promise((ok, falha) => (s.on('connect', ok), s.on('connect_error', falha)));
    s.disconnect();
  });

  test('bibliotecas servidas localmente', async () => {
    for (const p of ['/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/socket.io.min.js', '/vendor/capacitor.js', '/js/config.js', '/js/nativo.js']) {
      assert.equal((await fetch(ctx.base + p)).status, 200, p);
    }
  });
});
