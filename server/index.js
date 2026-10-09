const os = require('os');
const { exec } = require('child_process');
const { criarApp } = require('./app');
const { PORTA, ADMIN } = require('./config');
const { EXE, RAIZ } = require('./caminhos');

if (EXE) process.title = 'MotoX Servidor';

// No exe a janela fecharia na hora; espera o Enter para a pessoa conseguir ler o erro.
function falhar(mensagem) {
  console.error(`\n  ERRO: ${mensagem}\n`);
  if (!EXE) process.exit(1);
  console.error('  Pressione Enter para fechar.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

let ctx;
try {
  ctx = criarApp();
} catch (e) {
  falhar(`Não foi possível abrir o banco de dados em ${RAIZ}\\dados.\n    ${e.message}`);
}

if (ctx) {
  ctx.server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      falhar(`A porta ${PORTA} já está em uso. O MotoX já está aberto em outra janela?\n    Feche a outra janela ou defina outra porta (variável PORT).`);
    } else {
      falhar(e.message);
    }
  });

  ctx.server.listen(PORTA, '0.0.0.0', () => {
    // usado por scripts/gerar-exe.js para conferir que o exe novo liga de verdade antes de entregá-lo
    if (process.env.MOTOX_VERIFICAR === '1') {
      console.log('MOTOX_OK');
      return ctx.fechar().then(() => process.exit(0));
    }
    const local = `http://localhost:${PORTA}`;
    console.log(`\n  MotoX rodando!`);
    console.log(`  Neste computador:  ${local}`);
    for (const lista of Object.values(os.networkInterfaces())) {
      for (const i of lista || []) {
        if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) {
          console.log(`  No celular (Wi-Fi): http://${i.address}:${PORTA}`);
        }
      }
    }
    console.log(`  Admin: telefone ${ADMIN.telefone}`);
    if (EXE) {
      console.log(`  Dados salvos em:   ${RAIZ}\\dados`);
      console.log('\n  Deixe esta janela aberta. Para desligar o MotoX, feche-a.\n');
      if (process.env.MOTOX_NAO_ABRIR !== '1') exec(`start "" "${local}"`);
    } else {
      console.log('');
    }
  });
}
