const crypto = require('crypto');

function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, sal, 64).toString('hex');
  return `${sal}:${hash}`;
}

function conferirSenha(senha, armazenado) {
  const [sal, hash] = String(armazenado).split(':');
  if (!sal || !hash) return false;
  const esperado = Buffer.from(hash, 'hex');
  const calculado = crypto.scryptSync(senha, sal, 64);
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

const novoToken = () => crypto.randomBytes(32).toString('hex');

function usuarioPorToken(db, token) {
  if (!token) return null;
  const sql = `SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
               WHERE s.token = ? AND u.bloqueado = 0 AND u.excluido_em IS NULL`;
  return db.prepare(sql).get(token) || null;
}

module.exports = { hashSenha, conferirSenha, novoToken, usuarioPorToken };
