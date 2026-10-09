// Funções de apoio compartilhadas pelos arquivos de teste.
// Credenciais de admin só dos testes (definidas antes de carregar o servidor)
process.env.ADMIN_TELEFONE = '11900000000';
process.env.ADMIN_SENHA = 'admin-teste';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: conectar } = require('socket.io-client');
const { criarApp } = require('../server/app');

// Pontos reais em São Paulo
const PAULISTA = { lat: -23.5614, lng: -46.6559, endereco: 'Av. Paulista, 1000' };
const PINHEIROS = { lat: -23.5672, lng: -46.6925, endereco: 'Rua dos Pinheiros, 500' };
const PERTO = { lat: -23.5620, lng: -46.6565 }; // ~100 m da Paulista
const MEDIO = { lat: -23.5700, lng: -46.6450 }; // ~1,5 km
const LONGE = { lat: -23.0, lng: -46.0 }; // fora do raio

// Arquivos mínimos, mas válidos, para os documentos do motoboy
// (PNG de 1 pixel + bytes extras só para passar do tamanho mínimo)
const PNG = Buffer.concat([
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  Buffer.alloc(120),
]).toString('base64');
const PDF = Buffer.from(['%PDF-1.4', '1 0 obj << /Type /Catalog >> endobj', 'trailer << /Root 1 0 R >>', '%%EOF', ''].join('\n').repeat(3)).toString('base64');
const DOCS = { cnh: { nome: 'cnh.png', dados: 'data:image/png;base64,' + PNG }, crlv: { nome: 'crlv.pdf', dados: PDF } };

function iniciar(despacho = {}) {
  const pastaDocumentos = fs.mkdtempSync(path.join(os.tmpdir(), 'motox-docs-'));
  const ctx = criarApp({
    arquivoBanco: ':memory:',
    pastaDocumentos,
    usarOsrm: false,
    despacho: { tempoOfertaMs: 400, tempoMaxBuscaMs: 60000, varreduraMs: 100000, ...despacho },
  });
  ctx.pastaDocumentos = pastaDocumentos;
  const fecharOriginal = ctx.fechar;
  ctx.fechar = async () => {
    await fecharOriginal();
    fs.rmSync(pastaDocumentos, { recursive: true, force: true });
  };
  return new Promise((ok) =>
    ctx.server.listen(0, '127.0.0.1', () => {
      ctx.base = `http://127.0.0.1:${ctx.server.address().port}`;
      ok(ctx);
    })
  );
}

async function api(ctx, metodo, caminho, corpo, token) {
  const resp = await fetch(ctx.base + '/api' + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: resp.status, dados: await resp.json() };
}

let seq = 0;
async function registrar(ctx, tipo, extra = {}) {
  seq++;
  const corpo = {
    nome: `${tipo} ${seq}`,
    telefone: `119${String(seq).padStart(8, '0')}`,
    senha: 'segredo1',
    tipo,
    ...(tipo === 'motoboy' ? { placa: `ABC1D${String(seq).padStart(2, '0')}`, moto: 'Honda CG 160', documentos: DOCS } : {}),
    ...extra,
  };
  const { aprovar = true } = extra;
  delete corpo.aprovar;
  const r = await api(ctx, 'POST', '/auth/registrar', corpo);
  assert.equal(r.status, 201, JSON.stringify(r.dados));
  // motoboy só trabalha depois que o admin aprova os documentos
  if (tipo === 'motoboy' && aprovar) {
    const a = await api(ctx, 'POST', `/admin/usuarios/${r.dados.usuario.id}/analise`, { aprovar: true }, await tokenAdmin(ctx));
    assert.equal(a.status, 200, JSON.stringify(a.dados));
  }
  return r.dados.token;
}

async function tokenAdmin(ctx) {
  if (!ctx.tokenAdmin) {
    ctx.tokenAdmin = (await api(ctx, 'POST', '/auth/login', { telefone: '11900000000', senha: 'admin-teste' })).dados.token;
  }
  return ctx.tokenAdmin;
}

function socket(ctx, token) {
  return new Promise((ok, falha) => {
    const s = conectar(ctx.base, { auth: { token }, transports: ['websocket'], forceNew: true });
    s.on('connect', () => ok(s));
    s.on('connect_error', falha);
  });
}

const esperar = (s, evento, filtro = () => true, ms = 3000) =>
  new Promise((ok, falha) => {
    const t = setTimeout(() => falha(new Error(`timeout esperando "${evento}"`)), ms);
    const h = (d) => {
      if (!filtro(d)) return;
      clearTimeout(t);
      s.off(evento, h);
      ok(d);
    };
    s.on(evento, h);
  });

const emitirAck = (s, ev, d) => new Promise((ok) => s.emit(ev, d, ok));
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { DOCS, PNG, PDF, tokenAdmin, PAULISTA, PINHEIROS, PERTO, MEDIO, LONGE, iniciar, api, registrar, socket, conectar, esperar, emitirAck, pausa };
