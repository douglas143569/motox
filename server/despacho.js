const { distanciaKm } = require('./precos');
const { ATIVOS_SQL, buscarCorrida, serializarCorrida } = require('./corridas');

class ErroDespacho extends Error {}

// Despachante: guarda em memória quem está online e onde, e oferece cada corrida
// a um motoboy por vez (o mais próximo primeiro). Se ele recusar ou deixar o tempo
// acabar, a oferta passa para o próximo — igual Uber/99.
class Despachante {
  constructor({ db, io, tempoOfertaMs, raioKm, tempoMaxBuscaMs, varreduraMs }) {
    Object.assign(this, { db, io, tempoOfertaMs, raioKm, tempoMaxBuscaMs });
    this.motoboys = new Map(); // id -> { online, lat, lng, sockets:Set, ofertaCorrida }
    this.ofertas = new Map(); // corridaId -> { motoboyId, timer, expiraEm, distanciaAteColetaKm }
    this.recusas = new Map(); // corridaId -> Set(motoboyId)
    this.intervalo = setInterval(() => this.varrer(), varreduraMs);
    this.intervalo.unref();
  }

  parar() {
    clearInterval(this.intervalo);
    for (const o of this.ofertas.values()) clearTimeout(o.timer);
    this.ofertas.clear();
  }

  estado(id) {
    if (!this.motoboys.has(id)) {
      this.motoboys.set(id, { online: false, lat: null, lng: null, sockets: new Set(), ofertaCorrida: null });
    }
    return this.motoboys.get(id);
  }

  posicao(id) {
    const m = this.motoboys.get(id);
    return m && m.lat != null ? { lat: m.lat, lng: m.lng } : null;
  }

  corridaAtivaDoMotoboy(id) {
    const sql = `SELECT * FROM corridas WHERE motoboy_id = ? AND status IN (${ATIVOS_SQL}) ORDER BY id DESC LIMIT 1`;
    return this.db.prepare(sql).get(id) || null;
  }

  // ---------- presença e localização ----------

  conectar(id, socketId) {
    this.estado(id).sockets.add(socketId);
  }

  desconectar(id, socketId) {
    const m = this.estado(id);
    m.sockets.delete(socketId);
    if (m.sockets.size === 0) {
      m.online = false;
      if (m.ofertaCorrida) this.recusar(id, m.ofertaCorrida, { porTempo: true });
    }
  }

  definirOnline(id, online, lat, lng) {
    const m = this.estado(id);
    m.online = !!online;
    if (Number.isFinite(lat) && Number.isFinite(lng)) Object.assign(m, { lat, lng });
    if (!m.online && m.ofertaCorrida) this.recusar(id, m.ofertaCorrida);
    if (m.online) this.varrer();
  }

  // Conta bloqueada ou excluída: derruba as conexões e tira o motoboy da fila
  encerrarAcesso(id) {
    const m = this.motoboys.get(id);
    if (m) {
      m.online = false;
      if (m.ofertaCorrida) this.recusar(id, m.ofertaCorrida);
      this.motoboys.delete(id);
    }
    this.io.to(`usuario:${id}`).emit('conta:encerrada');
    this.io.in(`usuario:${id}`).disconnectSockets(true);
  }

  atualizarLocal(id, lat, lng) {
    Object.assign(this.estado(id), { lat, lng });
    const c = this.corridaAtivaDoMotoboy(id);
    if (!c) return;
    const msg = { corridaId: c.id, lat, lng };
    this.io.to(`usuario:${c.cliente_id}`).to(`rastreio:${c.codigo_rastreio}`).to('admin').emit('local', msg);
  }

  // ---------- notificação ----------

  serializar(c, visao) {
    return serializarCorrida(this.db, c, visao, c.motoboy_id ? this.posicao(c.motoboy_id) : null);
  }

  emitir(corridaId) {
    const c = buscarCorrida(this.db, corridaId);
    if (!c) return;
    this.io.to(`usuario:${c.cliente_id}`).emit('corrida', this.serializar(c, 'cliente'));
    if (c.motoboy_id) this.io.to(`usuario:${c.motoboy_id}`).emit('corrida', this.serializar(c, 'motoboy'));
    this.io.to(`rastreio:${c.codigo_rastreio}`).emit('corrida', this.serializar(c, 'publico'));
    this.io.to('admin').emit('corrida', this.serializar(c, 'admin'));
  }

  // ---------- ofertas ----------

  ofertaPendente(motoboyId) {
    const corridaId = this.estado(motoboyId).ofertaCorrida;
    const o = corridaId && this.ofertas.get(corridaId);
    if (!o) return null;
    return this.montarOferta(buscarCorrida(this.db, corridaId), o);
  }

  montarOferta(c, o) {
    return {
      corrida: this.serializar(c, 'motoboy'),
      distanciaAteColetaKm: Math.round(o.distanciaAteColetaKm * 10) / 10,
      tempoRestanteMs: Math.max(0, o.expiraEm - Date.now()),
      tempoTotalMs: this.tempoOfertaMs,
    };
  }

  candidatos(c) {
    const recusados = this.recusas.get(c.id) || new Set();
    const origem = { lat: c.origem_lat, lng: c.origem_lng };
    const lista = [];
    for (const [id, m] of this.motoboys) {
      if (!m.online || m.lat == null || m.ofertaCorrida || recusados.has(id)) continue;
      const d = distanciaKm(m, origem);
      if (d > this.raioKm || this.corridaAtivaDoMotoboy(id)) continue;
      lista.push({ id, d });
    }
    return lista.sort((a, b) => a.d - b.d);
  }

  despachar(corridaId) {
    if (this.ofertas.has(corridaId)) return;
    const c = buscarCorrida(this.db, corridaId);
    if (!c || c.status !== 'procurando') return;

    const [melhor] = this.candidatos(c);
    if (!melhor) {
      if (Date.now() - c.criado_em > this.tempoMaxBuscaMs) this.expirar(c.id);
      return;
    }

    const expiraEm = Date.now() + this.tempoOfertaMs;
    const timer = setTimeout(() => this.recusar(melhor.id, c.id, { porTempo: true }), this.tempoOfertaMs);
    const oferta = { motoboyId: melhor.id, timer, expiraEm, distanciaAteColetaKm: melhor.d };
    this.ofertas.set(c.id, oferta);
    this.estado(melhor.id).ofertaCorrida = c.id;
    this.io.to(`usuario:${melhor.id}`).emit('oferta', this.montarOferta(c, oferta));
  }

  liberarOferta(corridaId, evento) {
    const o = this.ofertas.get(corridaId);
    if (!o) return null;
    clearTimeout(o.timer);
    this.ofertas.delete(corridaId);
    this.estado(o.motoboyId).ofertaCorrida = null;
    if (evento) this.io.to(`usuario:${o.motoboyId}`).emit(evento, { corridaId });
    return o;
  }

  recusar(motoboyId, corridaId, { porTempo = false } = {}) {
    const o = this.ofertas.get(corridaId);
    if (!o || o.motoboyId !== motoboyId) return false;
    this.liberarOferta(corridaId, porTempo ? 'oferta:expirada' : null);
    if (!this.recusas.has(corridaId)) this.recusas.set(corridaId, new Set());
    this.recusas.get(corridaId).add(motoboyId);
    this.despachar(corridaId);
    return true;
  }

  aceitar(motoboyId, corridaId) {
    const o = this.ofertas.get(corridaId);
    if (!o || o.motoboyId !== motoboyId) throw new ErroDespacho('Esta oferta não está mais disponível.');
    this.liberarOferta(corridaId);
    const r = this.db
      .prepare(
        "UPDATE corridas SET status = 'a_caminho_coleta', motoboy_id = ?, aceito_em = ? WHERE id = ? AND status = 'procurando'"
      )
      .run(motoboyId, Date.now(), corridaId);
    if (r.changes === 0) throw new ErroDespacho('Esta corrida não está mais disponível.');
    this.recusas.delete(corridaId);
    this.emitir(corridaId);
  }

  // Motoboy desistiu antes de coletar: a corrida volta para a fila sem ele.
  devolverParaFila(corridaId, motoboyId) {
    if (!this.recusas.has(corridaId)) this.recusas.set(corridaId, new Set());
    this.recusas.get(corridaId).add(motoboyId);
    this.emitir(corridaId);
    this.despachar(corridaId);
  }

  cancelada(corridaId) {
    this.liberarOferta(corridaId, 'oferta:cancelada');
    this.recusas.delete(corridaId);
  }

  expirar(corridaId) {
    const r = this.db
      .prepare("UPDATE corridas SET status = 'expirada' WHERE id = ? AND status = 'procurando'")
      .run(corridaId);
    this.recusas.delete(corridaId);
    if (r.changes) this.emitir(corridaId);
  }

  varrer() {
    const pendentes = this.db.prepare("SELECT id FROM corridas WHERE status = 'procurando' ORDER BY id").all();
    for (const { id } of pendentes) this.despachar(id);
  }

  motoboysOnline() {
    const lista = [];
    for (const [id, m] of this.motoboys) {
      if (m.online && m.lat != null) lista.push({ id, lat: m.lat, lng: m.lng, emOferta: !!m.ofertaCorrida });
    }
    return lista;
  }
}

module.exports = { Despachante, ErroDespacho };
