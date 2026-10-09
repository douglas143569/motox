const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');
const { abrirBanco } = require('./db');
const { hashSenha, usuarioPorToken } = require('./auth');
const { Despachante } = require('./despacho');
const { criarRotas } = require('./rotas');
const { PUBLIC, BANCO, VENDOR, DOCUMENTOS } = require('./caminhos');

// Origem das páginas dentro dos apps Capacitor (Android usa http(s)://localhost, iOS capacitor://localhost)
const ORIGENS_APPS = ['http://localhost', 'https://localhost', 'capacitor://localhost'];

function liberarApps(req, res, next) {
  const origem = req.headers.origin;
  if (origem && ORIGENS_APPS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    // testes pelo Wi-Fi: o app (localhost) acessando o servidor por IP da rede local
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
}

function garantirAdmin(db) {
  const { telefone, senha, senhaHash } = config.ADMIN;
  if (db.prepare("SELECT 1 FROM usuarios WHERE tipo = 'admin'").get()) return;
  db.prepare(
    "INSERT INTO usuarios (nome, telefone, senha_hash, tipo, criado_em) VALUES ('Administrador', ?, ?, 'admin', ?)"
  ).run(telefone, senha ? hashSenha(senha) : senhaHash, Date.now());
}

const coordenadaValida = (d) =>
  d && Number.isFinite(d.lat) && Number.isFinite(d.lng) && Math.abs(d.lat) <= 90 && Math.abs(d.lng) <= 180;

function configurarSockets(io, db, desp) {
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      const u = usuarioPorToken(db, token);
      if (!u) return next(new Error('nao_autorizado'));
      socket.data.usuario = u;
    }
    next();
  });

  io.on('connection', (socket) => {
    const u = socket.data.usuario;
    if (u) {
      socket.join(`usuario:${u.id}`);
      if (u.tipo === 'admin') socket.join('admin');
    }

    if (u && u.tipo === 'motoboy') {
      desp.conectar(u.id, socket.id);
      socket.on('motoboy:status', (d, ack) => {
        const online = !!(d && d.online);
        // consulta o banco na hora: a análise do cadastro pode ter mudado depois da conexão
        const atual = db.prepare('SELECT status_cadastro FROM usuarios WHERE id = ?').get(u.id);
        if (online && (!atual || atual.status_cadastro !== 'aprovado')) {
          return typeof ack === 'function' && ack({ erro: 'Seu cadastro ainda está em análise. Você poderá ficar online assim que for aprovado.' });
        }
        if (online && !coordenadaValida(d) && !desp.posicao(u.id)) {
          return typeof ack === 'function' && ack({ erro: 'Defina sua localização antes de ficar online.' });
        }
        desp.definirOnline(u.id, online, d && d.lat, d && d.lng);
        if (typeof ack === 'function') ack({ ok: true, online });
      });
      socket.on('motoboy:local', (d) => {
        if (coordenadaValida(d)) desp.atualizarLocal(u.id, d.lat, d.lng);
      });
      socket.on('disconnect', () => desp.desconectar(u.id, socket.id));
    }

    // Rastreio público: qualquer pessoa com o código acompanha a entrega
    socket.on('rastrear', (codigo, ack) => {
      const c = db.prepare('SELECT * FROM corridas WHERE codigo_rastreio = ?').get(String(codigo || ''));
      if (!c) return typeof ack === 'function' && ack({ erro: 'Código de rastreio não encontrado.' });
      socket.join(`rastreio:${c.codigo_rastreio}`);
      if (typeof ack === 'function') ack({ corrida: desp.serializar(c, 'publico') });
    });
  });
}

function criarApp(opcoes = {}) {
  const db = abrirBanco(opcoes.arquivoBanco || BANCO);
  garantirAdmin(db);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: ORIGENS_APPS }, serveClient: false });
  const desp = new Despachante({ db, io, ...config.DESPACHO, ...(opcoes.despacho || {}) });
  const usarOsrm = opcoes.usarOsrm ?? process.env.OSRM !== '0';

  app.use(liberarApps);
  // só as rotas que recebem documentos (CNH, CRLV) aceitam corpo grande; o resto continua limitado
  app.use(['/api/auth/registrar', '/api/motoboy/documentos'], express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(PUBLIC, { extensions: ['html'] }));
  // bibliotecas servidas localmente (o app nativo leva uma cópia; ver scripts/montar-apps.js)
  for (const [rota, arquivo] of Object.entries(VENDOR)) app.use(rota, express.static(arquivo));
  app.use('/api', criarRotas({ db, desp, usarOsrm, pastaDocumentos: opcoes.pastaDocumentos || DOCUMENTOS }));
  configurarSockets(io, db, desp);

  const fechar = () =>
    new Promise((resolve) => {
      desp.parar();
      io.close(() => {
        db.close();
        resolve();
      });
    });

  return { app, server, io, db, desp, fechar };
}

module.exports = { criarApp };
