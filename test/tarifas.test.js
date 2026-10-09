// Tarifas editáveis, tarifa dinâmica e promoções/cupons
const { PAULISTA, PINHEIROS, PERTO, iniciar, api, registrar, socket, esperar, emitirAck } = require('./apoio');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { calcularPreco } = require('../server/precos');
const { dinamicaAgora, faixaAtiva, horaBrasilia, PADRAO } = require('../server/tarifas');

const copia = (o) => JSON.parse(JSON.stringify(o));

describe('tarifa dinâmica (regras)', () => {
  // 2026-10-09 é sexta-feira; 15:00 UTC = 12:00 em Brasília
  const sextaMeioDia = Date.UTC(2026, 9, 9, 15, 0);
  const sabado2h = Date.UTC(2026, 9, 10, 5, 0); // 02:00 de sábado em Brasília

  test('usa o horário de Brasília', () => {
    assert.deepEqual(horaBrasilia(sextaMeioDia), { dia: 5, minutos: 720 });
  });

  test('faixa que atravessa a meia-noite vale na madrugada do dia seguinte', () => {
    const noturnoSexta = { dias: [5], inicio: '22:00', fim: '06:00' };
    assert.equal(faixaAtiva(noturnoSexta, horaBrasilia(sabado2h)), true);
    assert.equal(faixaAtiva(noturnoSexta, horaBrasilia(sextaMeioDia)), false);
    assert.equal(faixaAtiva({ dias: [6], inicio: '22:00', fim: '06:00' }, horaBrasilia(sabado2h)), false);
  });

  test('vale a maior faixa, chuva multiplica por cima e tudo respeita o teto', () => {
    const t = copia(PADRAO);
    t.dinamica.faixas = [
      { nome: 'Almoço', dias: [5], inicio: '11:00', fim: '14:00', mult: 1.2, ativo: true },
      { nome: 'Sexta', dias: [5], inicio: '00:00', fim: '23:59', mult: 1.1, ativo: true },
      { nome: 'Desligada', dias: [5], inicio: '00:00', fim: '23:59', mult: 2, ativo: false },
    ];
    assert.deepEqual(dinamicaAgora(t, sextaMeioDia), { mult: 1.2, motivos: ['Almoço'] });
    t.dinamica.chuva = { ativo: true, mult: 1.2 };
    assert.deepEqual(dinamicaAgora(t, sextaMeioDia), { mult: 1.44, motivos: ['Almoço', 'Chuva'] });
    t.dinamica.teto = 1.3;
    assert.equal(dinamicaAgora(t, sextaMeioDia).mult, 1.3);
  });

  test('adicional vai para o motoboy conforme o repasse; comissão só sobre o preço base', () => {
    const t = copia(PADRAO);
    const p = calcularPreco({ distanciaKm: 10 }, t, { mult: 1.2, motivos: ['Chuva'] }); // base 26
    assert.equal(p.precoBase, 26);
    assert.equal(p.adicionalDinamico, 5.5); // 5,20 arredonda para 5,50
    assert.equal(p.preco, 31.5);
    assert.equal(p.ganhoMotoboy, 27.6); // 22,10 + 5,50
    assert.equal(p.taxaPlataforma, 3.9);
    assert.deepEqual(p.motivosDinamica, ['Chuva']);
    t.dinamica.repasseMotoboy = 0.5;
    assert.equal(calcularPreco({ distanciaKm: 10 }, t, { mult: 1.2, motivos: [] }).ganhoMotoboy, 24.85);
  });
});

describe('painel: tarifas e promoções', () => {
  let ctx, admin;
  const pedido = { origem: PAULISTA, destino: PINHEIROS };
  before(async () => {
    ctx = await iniciar({ tempoOfertaMs: 5000 });
    admin = (await api(ctx, 'POST', '/auth/login', { telefone: '11900000000', senha: 'admin-teste' })).dados.token;
  });
  after(() => ctx.fechar());

  const tarifasAtuais = async () => (await api(ctx, 'GET', '/admin/tarifas', null, admin)).dados.tarifas;
  const criarPromo = (dados) =>
    api(ctx, 'POST', '/admin/promocoes', { descricao: 'Teste', tipo: 'percentual', valor: 10, ...dados }, admin);

  async function motoboyOnline() {
    const mb = await registrar(ctx, 'motoboy');
    const s = await socket(ctx, mb);
    await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    return { mb, s };
  }

  test('admin altera tarifas e a cotação muda na hora; valores absurdos são recusados', async () => {
    const cli = await registrar(ctx, 'cliente');
    const antes = (await api(ctx, 'POST', '/cotacao', pedido, cli)).dados.preco;
    const t = await tarifasAtuais();
    t.base = PADRAO.base + 5;
    t.taxaPlataforma = 0.1;
    const r = await api(ctx, 'POST', '/admin/tarifas', { tarifas: t }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    assert.equal(r.dados.alteracao.por, 'Administrador');
    assert.equal((await api(ctx, 'POST', '/cotacao', pedido, cli)).dados.preco, antes + 5);

    const ruim = await api(ctx, 'POST', '/admin/tarifas', { tarifas: { ...t, taxaPlataforma: 0.9 } }, admin);
    assert.equal(ruim.status, 400);
    assert.match(ruim.dados.erro, /Comissão/);
    assert.equal((await api(ctx, 'POST', '/admin/tarifas', { tarifas: t }, cli)).status, 403);

    const sim = await api(ctx, 'POST', '/admin/tarifas/simular', { tarifas: { ...t, taxaPlataforma: 0.2 }, distanciaKm: 10 }, admin);
    assert.equal(sim.dados.preco, 31); // 12 + 19
    assert.equal(sim.dados.taxaPlataforma, 6.2);
    assert.equal((await tarifasAtuais()).taxaPlataforma, 0.1, 'simular não salva');
  });

  test('modo chuva: cliente vê o motivo e o motoboy vê o adicional na oferta', async () => {
    const t = await tarifasAtuais();
    t.dinamica.chuva = { ativo: true, mult: 1.2 };
    await api(ctx, 'POST', '/admin/tarifas', { tarifas: t }, admin);
    const cli = await registrar(ctx, 'cliente');
    const cot = (await api(ctx, 'POST', '/cotacao', pedido, cli)).dados;
    assert.ok(cot.adicionalDinamico > 0);
    assert.deepEqual(cot.motivosDinamica, ['Chuva']);

    const { s } = await motoboyOnline();
    const of = esperar(s, 'oferta');
    const c = (await api(ctx, 'POST', '/corridas', pedido, cli)).dados;
    const o = (await of).corrida;
    assert.equal(o.adicionalDinamico, cot.adicionalDinamico);
    assert.equal(o.motivoDinamico, 'Chuva');
    await api(ctx, 'POST', `/corridas/${c.id}/cancelar`, {}, cli);
    t.dinamica.chuva.ativo = false;
    await api(ctx, 'POST', '/admin/tarifas', { tarifas: t }, admin);
    s.disconnect();
  });

  test('cupom percentual com teto: desconto sai da plataforma, ganho do motoboy intacto', async () => {
    assert.equal((await criarPromo({ codigo: 'metade', valor: 50, descontoMax: 5 })).status, 201);
    assert.equal((await criarPromo({ codigo: 'METADE' })).status, 409, 'código repetido');
    assert.equal((await criarPromo({ codigo: 'X' })).status, 400, 'código curto');
    assert.equal((await criarPromo({ codigo: 'DEMAIS', valor: 150 })).status, 400, 'mais de 100%');

    const cli = await registrar(ctx, 'cliente');
    const sem = (await api(ctx, 'POST', '/cotacao', pedido, cli)).dados;
    const com = (await api(ctx, 'POST', '/cotacao', { ...pedido, cupom: ' metade ' }, cli)).dados;
    assert.equal(com.desconto, 5, 'limitado ao desconto máximo');
    assert.equal(com.preco, sem.preco - 5);
    assert.equal(com.precoOriginal, sem.preco);
    assert.equal(com.cupom.codigo, 'METADE');

    const c = (await api(ctx, 'POST', '/corridas', { ...pedido, cupom: 'metade' }, cli)).dados;
    assert.equal(c.desconto, 5);
    assert.equal(c.cupom, 'METADE');
    const adm = (await api(ctx, 'GET', '/admin/resumo', null, admin)).dados.corridas.find((x) => x.id === c.id);
    const cheio = calcularPreco({ distanciaKm: c.distanciaKm }, await tarifasAtuais());
    assert.equal(adm.ganhoMotoboy, cheio.ganhoMotoboy, 'motoboy ganha o mesmo');
    assert.equal(adm.taxaPlataforma, Math.round((cheio.taxaPlataforma - 5) * 100) / 100);
    await api(ctx, 'POST', `/corridas/${c.id}/cancelar`, {}, cli);
  });

  test('regras: inexistente, pedido mínimo, pausado, vencido e agendado', async () => {
    const cli = await registrar(ctx, 'cliente');
    const cot = (cupom) => api(ctx, 'POST', '/cotacao', { ...pedido, cupom }, cli).then((r) => r.dados);

    const inexistente = await cot('NAOEXISTE');
    assert.match(inexistente.cupomErro, /não encontrado/);
    assert.equal(inexistente.desconto, 0);
    assert.equal((await api(ctx, 'POST', '/corridas', { ...pedido, cupom: 'NAOEXISTE' }, cli)).status, 400, 'no pedido, bloqueia');

    await criarPromo({ codigo: 'MINIMO', pedidoMinimo: 999 });
    assert.match((await cot('MINIMO')).cupomErro, /a partir de R\$ 999,00/);

    const pausada = (await criarPromo({ codigo: 'PAUSADA' })).dados;
    await api(ctx, 'POST', `/admin/promocoes/${pausada.id}/ativo`, { ativo: false }, admin);
    assert.match((await cot('PAUSADA')).cupomErro, /não está mais válido/);
    assert.equal((await api(ctx, 'DELETE', `/admin/promocoes/${pausada.id}`, null, admin)).status, 200, 'nunca usada: pode apagar');

    await criarPromo({ codigo: 'VENCIDA', inicio: Date.now() - 2e6, fim: Date.now() - 1e6 });
    assert.match((await cot('VENCIDA')).cupomErro, /não está mais válido/);
    await criarPromo({ codigo: 'FUTURA', inicio: Date.now() + 864e5 });
    assert.match((await cot('FUTURA')).cupomErro, /vale a partir/);
    assert.equal((await criarPromo({ codigo: 'INVERTIDA', inicio: Date.now(), fim: Date.now() - 1000 })).status, 400);
  });

  test('limites de uso: por cliente e total; cancelada devolve o uso; usada não se apaga', async () => {
    await criarPromo({ codigo: 'UMAVEZ', tipo: 'fixo', valor: 3, limitePorCliente: 1 });
    const cli = await registrar(ctx, 'cliente');
    const cot = (cupom) => api(ctx, 'POST', '/cotacao', { ...pedido, cupom }, cli).then((r) => r.dados);

    const c1 = (await api(ctx, 'POST', '/corridas', { ...pedido, cupom: 'UMAVEZ' }, cli)).dados;
    assert.equal(c1.desconto, 3);
    await api(ctx, 'POST', `/corridas/${c1.id}/cancelar`, {}, cli);
    assert.equal((await cot('UMAVEZ')).desconto, 3, 'corrida cancelada devolve o uso');

    const { mb, s } = await motoboyOnline();
    const of = esperar(s, 'oferta');
    const c2 = (await api(ctx, 'POST', '/corridas', { ...pedido, cupom: 'UMAVEZ' }, cli)).dados;
    await of;
    await api(ctx, 'POST', `/corridas/${c2.id}/aceitar`, {}, mb);
    await api(ctx, 'POST', `/corridas/${c2.id}/coletar`, {}, mb);
    await api(ctx, 'POST', `/corridas/${c2.id}/entregar`, { pin: c2.pin }, mb);
    assert.match((await cot('UMAVEZ')).cupomErro, /máximo de vezes/);
    s.disconnect();

    const esgota = (await criarPromo({ codigo: 'ESGOTA', limiteTotal: 1 })).dados;
    const outro = await registrar(ctx, 'cliente');
    const c3 = (await api(ctx, 'POST', '/corridas', { ...pedido, cupom: 'ESGOTA' }, outro)).dados;
    assert.ok(c3.desconto > 0);
    assert.match((await cot('ESGOTA')).cupomErro, /esgotou/);
    const lista = (await api(ctx, 'GET', '/admin/promocoes', null, admin)).dados;
    const p = lista.promocoes.find((x) => x.id === esgota.id);
    assert.equal(p.situacao, 'esgotada');
    assert.equal(p.usos, 1);
    assert.ok(lista.mes.total > 0);
    assert.equal((await api(ctx, 'DELETE', `/admin/promocoes/${esgota.id}`, null, admin)).status, 409);
    await api(ctx, 'POST', `/corridas/${c3.id}/cancelar`, {}, outro);
  });

  test('boas-vindas automática: aplica sem código, só enquanto for a primeira entrega', async () => {
    await criarPromo({ codigo: 'BEMVINDO', descricao: '20% na primeira entrega', valor: 20, automatica: true, soPrimeiraCorrida: true });
    const novo = await registrar(ctx, 'cliente');
    const cot = (await api(ctx, 'POST', '/cotacao', pedido, novo)).dados;
    assert.deepEqual(cot.cupom, { codigo: 'BEMVINDO', descricao: '20% na primeira entrega', automatico: true });
    assert.ok(cot.desconto > 0);

    const c = (await api(ctx, 'POST', '/corridas', pedido, novo)).dados;
    assert.equal(c.cupom, 'BEMVINDO');
    // com uma entrega em andamento, já não é "primeira": outra cotação não ganha o desconto
    const durante = (await api(ctx, 'POST', '/cotacao', pedido, novo)).dados;
    assert.equal(durante.cupom, null);
    await api(ctx, 'POST', `/corridas/${c.id}/cancelar`, {}, novo);
    assert.equal((await api(ctx, 'POST', '/cotacao', pedido, novo)).dados.cupom.codigo, 'BEMVINDO', 'cancelada não conta');
  });
});
