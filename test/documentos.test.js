// Cadastro do motoboy com CNH e documento da moto, e análise pelo admin
const { DOCS, PNG, PDF, PERTO, iniciar, api, registrar, socket, esperar, emitirAck, tokenAdmin } = require('./apoio');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { detectarFormato } = require('../server/documentos');

let seq = 0;
const corpoMotoboy = (extra = {}) => ({
  nome: 'Douglas Teste',
  telefone: `1198${String(++seq).padStart(7, '0')}`,
  senha: 'segredo1',
  tipo: 'motoboy',
  placa: 'DOC1A23',
  moto: 'Honda CG 160',
  documentos: DOCS,
  ...extra,
});

describe('formato dos documentos', () => {
  test('reconhece pelo conteúdo, não pelo nome', () => {
    assert.equal(detectarFormato(Buffer.from(PNG, 'base64')), 'image/png');
    assert.equal(detectarFormato(Buffer.from(PDF, 'base64')), 'application/pdf');
    assert.equal(detectarFormato(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(detectarFormato(Buffer.from('MZ executável disfarçado')), null);
  });
});

describe('cadastro e análise do motoboy', () => {
  let ctx, admin;
  before(async () => {
    ctx = await iniciar();
    admin = await tokenAdmin(ctx);
  });
  after(() => ctx.fechar());

  test('sem CNH ou sem documento da moto, não cadastra (e não sobra conta)', async () => {
    const semCnh = corpoMotoboy({ documentos: { crlv: DOCS.crlv } });
    let r = await api(ctx, 'POST', '/auth/registrar', semCnh);
    assert.equal(r.status, 400);
    assert.match(r.dados.erro, /carteira de motorista/);
    r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: { cnh: DOCS.cnh } }));
    assert.match(r.dados.erro, /documento da moto/);
    r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: undefined }));
    assert.equal(r.status, 400);
    // o telefone recusado continua livre: nenhuma conta foi criada
    assert.equal((await api(ctx, 'POST', '/auth/registrar', { ...semCnh, documentos: DOCS })).status, 201);
  });

  test('recusa arquivo que não é foto nem PDF, corrompido, vazio ou grande demais', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(500)]).toString('base64');
    let r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: { ...DOCS, cnh: { nome: 'cnh.jpg', dados: exe } } }));
    assert.match(r.dados.erro, /Formato .* não aceito/);
    r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: { ...DOCS, crlv: { dados: '###' } } }));
    assert.match(r.dados.erro, /corrompido/);
    r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: { ...DOCS, crlv: { dados: 'JVBERi0=' } } }));
    assert.match(r.dados.erro, /vazio/);
    const grande = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(7 * 1024 * 1024)]).toString('base64');
    r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ documentos: { ...DOCS, crlv: { dados: grande } } }));
    assert.match(r.dados.erro, /maior que 6 MB/);
  });

  test('cliente se cadastra sem documentos e já começa aprovado', async () => {
    const r = await api(ctx, 'POST', '/auth/registrar', { nome: 'Cli', telefone: '11977700001', senha: 'segredo1', tipo: 'cliente' });
    assert.equal(r.dados.usuario.statusCadastro, 'aprovado');
  });

  test('em análise: entra no app, mas não fica online nem aceita corrida', async () => {
    const r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy());
    assert.equal(r.status, 201);
    assert.equal(r.dados.usuario.statusCadastro, 'pendente');
    const tok = r.dados.token;
    const docs = (await api(ctx, 'GET', '/motoboy/documentos', null, tok)).dados;
    assert.deepEqual(docs.documentos.map((d) => d.tipo).sort(), ['cnh', 'crlv']);
    const s = await socket(ctx, tok);
    const ack = await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    assert.match(ack.erro, /em análise/);
    assert.equal((await api(ctx, 'POST', '/corridas/1/aceitar', {}, tok)).status, 403);
    s.disconnect();
  });

  test('admin vê os pendentes e abre os arquivos; ninguém mais abre', async () => {
    const r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy({ nome: 'Pendente Visivel' }));
    const id = r.dados.usuario.id;
    const lista = (await api(ctx, 'GET', '/admin/usuarios?cadastro=pendente', null, admin)).dados;
    const u = lista.find((x) => x.id === id);
    assert.ok(u, 'aparece no filtro de pendentes');
    assert.equal(u.documentos.length, 2);
    assert.ok((await api(ctx, 'GET', '/admin/resumo', null, admin)).dados.cadastrosPendentes >= 1);

    const cnh = u.documentos.find((d) => d.tipo === 'cnh');
    const baixar = (token) => fetch(`${ctx.base}/api/admin/documentos/${cnh.id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const resp = await baixar(admin);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'image/png');
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.ok(Buffer.from(await resp.arrayBuffer()).equals(Buffer.from(PNG, 'base64')), 'arquivo íntegro');
    assert.equal((await baixar(r.dados.token)).status, 403, 'nem o próprio motoboy baixa pela rota do admin');
    assert.equal((await baixar(null)).status, 401);
    // não existe caminho público para os arquivos
    assert.equal((await fetch(`${ctx.base}/dados/documentos/${id}/`)).status, 404);
  });

  test('reprovar exige motivo e avisa o motoboy na hora; ele reenvia e volta para análise', async () => {
    const r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy());
    const { id } = r.dados.usuario;
    const s = await socket(ctx, r.dados.token);

    assert.equal((await api(ctx, 'POST', `/admin/usuarios/${id}/analise`, { aprovar: false }, admin)).status, 400);
    const aviso = esperar(s, 'conta:cadastro');
    const rep = await api(ctx, 'POST', `/admin/usuarios/${id}/analise`, { aprovar: false, motivo: 'Foto da CNH ilegível' }, admin);
    assert.equal(rep.dados.statusCadastro, 'reprovado');
    assert.deepEqual(await aviso, { statusCadastro: 'reprovado', motivoReprovacao: 'Foto da CNH ilegível' });
    assert.equal((await api(ctx, 'GET', '/eu', null, r.dados.token)).dados.motivoReprovacao, 'Foto da CNH ilegível');

    const antes = (await api(ctx, 'GET', '/motoboy/documentos', null, r.dados.token)).dados.documentos;
    const reenvio = await api(ctx, 'POST', '/motoboy/documentos', { documentos: { cnh: DOCS.cnh } }, r.dados.token);
    assert.equal(reenvio.status, 200, JSON.stringify(reenvio.dados));
    assert.equal(reenvio.dados.statusCadastro, 'pendente');
    const cnhNova = reenvio.dados.documentos.find((d) => d.tipo === 'cnh');
    assert.notEqual(cnhNova.id, antes.find((d) => d.tipo === 'cnh').id, 'a CNH nova substitui a antiga');
    assert.equal(reenvio.dados.documentos.find((d) => d.tipo === 'crlv').id, antes.find((d) => d.tipo === 'crlv').id, 'o CRLV continua');
    assert.equal((await api(ctx, 'POST', '/motoboy/documentos', {}, r.dados.token)).status, 400);

    const aprovado = esperar(s, 'conta:cadastro');
    await api(ctx, 'POST', `/admin/usuarios/${id}/analise`, { aprovar: true }, admin);
    assert.equal((await aprovado).statusCadastro, 'aprovado');
    const ack = await emitirAck(s, 'motoboy:status', { online: true, ...PERTO });
    assert.deepEqual(ack, { ok: true, online: true });
    assert.equal((await api(ctx, 'POST', '/motoboy/documentos', { documentos: DOCS }, r.dados.token)).status, 409, 'aprovado não troca sozinho');
    s.disconnect();
  });

  test('cliente e motoboy não acessam a análise', async () => {
    const mb = await registrar(ctx, 'motoboy');
    const cli = await registrar(ctx, 'cliente');
    assert.equal((await api(ctx, 'POST', '/admin/usuarios/1/analise', { aprovar: true }, mb)).status, 403);
    assert.equal((await api(ctx, 'POST', '/admin/usuarios/1/analise', { aprovar: true }, cli)).status, 403);
    assert.equal((await api(ctx, 'GET', '/motoboy/documentos', null, cli)).status, 403);
  });

  test('excluir a conta apaga os documentos do disco (LGPD)', async () => {
    const r = await api(ctx, 'POST', '/auth/registrar', corpoMotoboy());
    const pasta = path.join(ctx.pastaDocumentos, String(r.dados.usuario.id));
    assert.equal(fs.readdirSync(pasta).length, 2);
    assert.equal((await api(ctx, 'DELETE', `/admin/usuarios/${r.dados.usuario.id}`, null, admin)).status, 200);
    assert.equal(fs.existsSync(pasta), false);
  });
});
