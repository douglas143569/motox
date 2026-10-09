// Documentos do cadastro do motoboy (CNH e CRLV).
// Chegam em base64 (o app já comprime as fotos), são conferidos pelo conteúdo — não pelo nome do
// arquivo — e gravados fora da pasta pública. Só o admin consegue abri-los.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ErroDocumento extends Error {}

const TIPOS_DOC = {
  cnh: 'a carteira de motorista (CNH)',
  crlv: 'o documento da moto (CRLV)',
};
const TAMANHO_MAX = 6 * 1024 * 1024; // 6 MB por arquivo
const TAMANHO_MIN = 100; // menos que isso não é um documento legível

const EXTENSAO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

// Identifica o formato pelos primeiros bytes; extensão e "mime" enviados pelo navegador não são confiáveis.
function detectarFormato(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

function decodificar(arquivo, tipo) {
  const nome = TIPOS_DOC[tipo];
  if (!arquivo || typeof arquivo.dados !== 'string' || !arquivo.dados) throw new ErroDocumento(`Anexe ${nome}.`);
  const base64 = arquivo.dados.replace(/^data:[^;,]+;base64,/, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) throw new ErroDocumento(`O arquivo de ${nome} está corrompido. Anexe novamente.`);
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > TAMANHO_MAX) throw new ErroDocumento(`O arquivo de ${nome} é maior que 6 MB. Envie uma foto ou um PDF menor.`);
  if (buf.length < TAMANHO_MIN) throw new ErroDocumento(`O arquivo de ${nome} está vazio ou ilegível.`);
  const mime = detectarFormato(buf);
  if (!mime) throw new ErroDocumento(`Formato de ${nome} não aceito. Envie uma foto (JPG ou PNG) ou um PDF.`);
  return { tipo, buf, mime, nomeOriginal: String(arquivo.nome || '').slice(0, 120) };
}

// Confere os documentos enviados. obrigatorios: tipos que precisam vir nesta requisição.
function validarDocumentos(docs, obrigatorios = Object.keys(TIPOS_DOC)) {
  const lista = [];
  for (const tipo of Object.keys(TIPOS_DOC)) {
    const veio = docs && docs[tipo];
    if (!veio && !obrigatorios.includes(tipo)) continue;
    lista.push(decodificar(veio, tipo));
  }
  if (!lista.length) throw new ErroDocumento('Anexe pelo menos um documento.');
  return lista;
}

function gravarDocumentos(db, pasta, usuarioId, lista) {
  const dir = path.join(pasta, String(usuarioId));
  fs.mkdirSync(dir, { recursive: true });
  const ins = db.prepare(
    'INSERT INTO documentos (usuario_id, tipo, arquivo, mime, tamanho, nome_original, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const d of lista) {
    // nome aleatório: nada do que o usuário mandou vira caminho no disco
    const arquivo = `${d.tipo}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${EXTENSAO[d.mime]}`;
    fs.writeFileSync(path.join(dir, arquivo), d.buf);
    ins.run(usuarioId, d.tipo, `${usuarioId}/${arquivo}`, d.mime, d.buf.length, d.nomeOriginal || null, Date.now());
  }
}

// Documento mais recente de cada tipo
function documentosAtuais(db, usuarioId) {
  const todos = db
    .prepare('SELECT id, tipo, mime, tamanho, nome_original, criado_em FROM documentos WHERE usuario_id = ? ORDER BY id DESC')
    .all(usuarioId);
  const atuais = {};
  for (const d of todos) if (!atuais[d.tipo]) atuais[d.tipo] = d;
  return Object.values(atuais).map((d) => ({
    id: d.id,
    tipo: d.tipo,
    mime: d.mime,
    tamanho: d.tamanho,
    nomeOriginal: d.nome_original,
    enviadoEm: d.criado_em,
  }));
}

function caminhoDocumento(db, pasta, docId) {
  const d = db.prepare('SELECT * FROM documentos WHERE id = ?').get(docId);
  if (!d) return null;
  const completo = path.resolve(pasta, d.arquivo);
  // defesa extra: o arquivo tem de estar dentro da pasta de documentos
  if (!completo.startsWith(path.resolve(pasta) + path.sep)) return null;
  return { ...d, completo };
}

// LGPD: ao excluir a conta, os documentos pessoais vão junto
function apagarDocumentos(db, pasta, usuarioId) {
  db.prepare('DELETE FROM documentos WHERE usuario_id = ?').run(usuarioId);
  fs.rmSync(path.join(pasta, String(usuarioId)), { recursive: true, force: true });
}

module.exports = {
  ErroDocumento,
  TIPOS_DOC,
  detectarFormato,
  validarDocumentos,
  gravarDocumentos,
  documentosAtuais,
  caminhoDocumento,
  apagarDocumentos,
};
