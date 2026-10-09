const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS usuarios (
      id          INTEGER PRIMARY KEY,
      nome        TEXT NOT NULL,
      telefone    TEXT NOT NULL UNIQUE,
      senha_hash  TEXT NOT NULL,
      tipo        TEXT NOT NULL CHECK (tipo IN ('cliente','motoboy','admin')),
      placa       TEXT,
      moto        TEXT,
      nota_soma   REAL NOT NULL DEFAULT 0,
      nota_qtd    INTEGER NOT NULL DEFAULT 0,
      criado_em   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      token      TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      criado_em  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS corridas (
      id                   INTEGER PRIMARY KEY,
      cliente_id           INTEGER NOT NULL REFERENCES usuarios(id),
      motoboy_id           INTEGER REFERENCES usuarios(id),
      status               TEXT NOT NULL,
      origem_end           TEXT NOT NULL,
      origem_lat           REAL NOT NULL,
      origem_lng           REAL NOT NULL,
      destino_end          TEXT NOT NULL,
      destino_lat          REAL NOT NULL,
      destino_lng          REAL NOT NULL,
      distancia_km         REAL NOT NULL,
      duracao_min          REAL NOT NULL,
      rota_json            TEXT,
      tamanho              TEXT NOT NULL,
      ida_volta            INTEGER NOT NULL DEFAULT 0,
      pagamento            TEXT NOT NULL,
      observacoes          TEXT,
      destinatario_nome    TEXT,
      destinatario_tel     TEXT,
      preco                REAL NOT NULL,
      ganho_motoboy        REAL NOT NULL,
      taxa_plataforma      REAL NOT NULL,
      pin_entrega          TEXT NOT NULL,
      codigo_rastreio      TEXT NOT NULL UNIQUE,
      avaliacao_do_cliente INTEGER,
      avaliacao_do_motoboy INTEGER,
      criado_em            INTEGER NOT NULL,
      aceito_em            INTEGER,
      chegou_coleta_em     INTEGER,
      coletado_em          INTEGER,
      entregue_em          INTEGER,
      finalizado_em        INTEGER,
      cancelado_em         INTEGER,
      cancelado_por        TEXT
    );

    CREATE TABLE IF NOT EXISTS configuracoes (
      chave          TEXT PRIMARY KEY,
      valor          TEXT NOT NULL,
      atualizado_em  INTEGER NOT NULL,
      atualizado_por INTEGER REFERENCES usuarios(id)
    );

    CREATE TABLE IF NOT EXISTS historico_tarifas (
      id           INTEGER PRIMARY KEY,
      tarifas_json TEXT NOT NULL,
      usuario_id   INTEGER REFERENCES usuarios(id),
      criado_em    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promocoes (
      id                  INTEGER PRIMARY KEY,
      codigo              TEXT NOT NULL UNIQUE,
      descricao           TEXT NOT NULL,
      tipo                TEXT NOT NULL CHECK (tipo IN ('percentual','fixo')),
      valor               REAL NOT NULL,
      desconto_max        REAL,
      pedido_minimo       REAL,
      inicio              INTEGER,
      fim                 INTEGER,
      limite_total        INTEGER,
      limite_por_cliente  INTEGER,
      so_primeira_corrida INTEGER NOT NULL DEFAULT 0,
      automatica          INTEGER NOT NULL DEFAULT 0,
      ativo               INTEGER NOT NULL DEFAULT 1,
      criado_em           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documentos (
      id            INTEGER PRIMARY KEY,
      usuario_id    INTEGER NOT NULL REFERENCES usuarios(id),
      tipo          TEXT NOT NULL CHECK (tipo IN ('cnh','crlv')),
      arquivo       TEXT NOT NULL,
      mime          TEXT NOT NULL,
      tamanho       INTEGER NOT NULL,
      nome_original TEXT,
      criado_em     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documentos_usuario ON documentos(usuario_id);

    CREATE INDEX IF NOT EXISTS idx_corridas_status ON corridas(status);
    CREATE INDEX IF NOT EXISTS idx_corridas_cliente ON corridas(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_corridas_motoboy ON corridas(motoboy_id);
  `);
  migrar(db);
  return db;
}

// Colunas adicionadas depois da primeira versão: incluídas em bancos já existentes.
function migrar(db) {
  const colunas = new Set(db.prepare('PRAGMA table_info(usuarios)').all().map((c) => c.name));
  if (!colunas.has('bloqueado')) db.exec('ALTER TABLE usuarios ADD COLUMN bloqueado INTEGER NOT NULL DEFAULT 0');
  if (!colunas.has('excluido_em')) db.exec('ALTER TABLE usuarios ADD COLUMN excluido_em INTEGER');

  // Análise do cadastro: motoboy só fica online depois de aprovado (clientes já nascem aprovados)
  if (!colunas.has('status_cadastro')) {
    db.exec("ALTER TABLE usuarios ADD COLUMN status_cadastro TEXT NOT NULL DEFAULT 'aprovado'");
    // motoboys de antes desta versão não enviaram documentos: precisam enviar e passar pela análise
    db.exec("UPDATE usuarios SET status_cadastro = 'pendente' WHERE tipo = 'motoboy' AND excluido_em IS NULL");
  }
  if (!colunas.has('motivo_reprovacao')) db.exec('ALTER TABLE usuarios ADD COLUMN motivo_reprovacao TEXT');
  if (!colunas.has('analisado_em')) db.exec('ALTER TABLE usuarios ADD COLUMN analisado_em INTEGER');

  // preço: "preco" é o que o cliente paga; "preco_original" é antes do desconto do cupom
  const colCorridas = new Set(db.prepare('PRAGMA table_info(corridas)').all().map((c) => c.name));
  const novas = {
    preco_original: 'REAL',
    desconto: 'REAL NOT NULL DEFAULT 0',
    promocao_id: 'INTEGER REFERENCES promocoes(id)',
    cupom: 'TEXT',
    adicional_dinamico: 'REAL NOT NULL DEFAULT 0',
    motivo_dinamico: 'TEXT',
  };
  for (const [col, tipo] of Object.entries(novas)) {
    if (!colCorridas.has(col)) db.exec(`ALTER TABLE corridas ADD COLUMN ${col} ${tipo}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_corridas_promocao ON corridas(promocao_id)');
}

module.exports = { abrirBanco };
