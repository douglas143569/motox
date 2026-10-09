// Troca o telefone e a senha do administrador num banco que já existe.
//
//   npm run admin -- 11999998888 novaSenha                       (banco do projeto: dados/motox.db)
//   npm run admin -- 11999998888 novaSenha "C:\caminho\dados\motox.db"   (ex.: banco do MotoX.exe)
//
// Feche o MotoX antes. As sessões abertas do admin são encerradas.
const fs = require('fs');
const path = require('path');
const { abrirBanco } = require('../server/db');
const { hashSenha } = require('../server/auth');

const [telefoneBruto, senha, arquivo = path.join(__dirname, '..', 'dados', 'motox.db')] = process.argv.slice(2);
const telefone = String(telefoneBruto || '').replace(/\D/g, '');

if (!/^\d{10,11}$/.test(telefone) || !senha) {
  console.error('Uso: npm run admin -- <telefone com DDD> <senha> [arquivo do banco]');
  process.exit(1);
}
if (senha.length < 6) {
  console.error('A senha precisa ter pelo menos 6 caracteres.');
  process.exit(1);
}
if (!fs.existsSync(arquivo)) {
  console.log(`Banco não encontrado em ${arquivo}. Nada a trocar: na primeira execução o admin é criado pelo config.`);
  process.exit(0);
}

const db = abrirBanco(arquivo);
const admin = db.prepare("SELECT id FROM usuarios WHERE tipo = 'admin' ORDER BY id LIMIT 1").get();
if (!admin) {
  console.error('Nenhum administrador neste banco.');
  process.exit(1);
}
const dono = db.prepare('SELECT nome FROM usuarios WHERE telefone = ? AND id <> ?').get(telefone, admin.id);
if (dono) {
  console.error(`O telefone ${telefone} já pertence à conta "${dono.nome}". Use outro número ou exclua essa conta.`);
  process.exit(1);
}
db.prepare('UPDATE usuarios SET telefone = ?, senha_hash = ? WHERE id = ?').run(telefone, hashSenha(senha), admin.id);
db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(admin.id);
db.close();
console.log(`✔ Administrador atualizado em ${arquivo}. Entre com o telefone ${telefone} e a nova senha.`);
