// Gera dist/MotoX-Servidor/MotoX.exe: o servidor completo num executável Windows
// que não precisa de Node instalado (Node "Single Executable Application").
//
//   npm run exe
//
// Resultado (a pasta inteira é o programa; copie-a toda):
//   dist/MotoX-Servidor/
//     MotoX.exe     servidor + Node embutidos
//     public/       páginas do sistema
//     vendor/       mapa e tempo real
//     dados/        banco de dados (criado na primeira execução e preservado ao regerar)
//   dist/MotoX-Servidor.zip   a mesma pasta compactada, para levar a outro computador
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const esbuild = require('esbuild');
const { ARQUIVOS_VENDOR } = require('../server/caminhos');
const pacote = require('../package.json');

const RAIZ = path.join(__dirname, '..');
const BUILD = path.join(RAIZ, 'build');
const SAIDA = path.join(RAIZ, 'dist', 'MotoX-Servidor');
const EXE = path.join(SAIDA, 'MotoX.exe');
const FUSIVEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

async function main() {
  if (process.platform !== 'win32') throw new Error('Este script gera o executável do Windows; rode-o no Windows.');

  console.log('1/5 Juntando o servidor num arquivo só…');
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(RAIZ, 'server', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: path.join(BUILD, 'motox.cjs'),
    // dependências opcionais de desempenho do WebSocket: o ws funciona sem elas
    external: ['bufferutil', 'utf-8-validate'],
    logLevel: 'warning',
  });

  console.log('2/5 Preparando o pacote do Node…');
  const blob = path.join(BUILD, 'motox.blob');
  fs.writeFileSync(
    path.join(BUILD, 'sea-config.json'),
    JSON.stringify({ main: path.join(BUILD, 'motox.cjs'), output: blob, disableExperimentalSEAWarning: true })
  );
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], { stdio: 'inherit' });

  // O exe é montado e TESTADO na pasta build/; só substitui o da pasta do programa se ligar de verdade.
  // (Antes, uma falha no meio deixava um exe incompleto no lugar do que funcionava.)
  console.log('3/5 Criando o MotoX.exe (ícone, nome e versão)…');
  const exeNovo = path.join(BUILD, 'MotoX.exe');
  fs.copyFileSync(process.execPath, exeNovo);
  await aplicarIcone(exeNovo);
  // o ícone tem de entrar antes: alterar recursos depois da injeção corromperia o exe
  execFileSync(
    process.execPath,
    [require.resolve('postject/dist/cli.js'), exeNovo, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSIVEL],
    { stdio: 'inherit' }
  );
  if (!fs.readFileSync(exeNovo).includes(`${FUSIVEL}:1`)) {
    throw new Error('O MotoX não foi embutido no executável (fusível do Node desligado).');
  }

  console.log('4/5 Testando o exe novo e montando a pasta do programa…');
  verificarExe(exeNovo);
  fs.mkdirSync(SAIDA, { recursive: true });
  try {
    fs.copyFileSync(exeNovo, EXE);
  } catch (e) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
      throw new Error('Não consegui substituir o MotoX.exe: ele está aberto. Feche a janela do MotoX e rode de novo.');
    }
    throw e;
  }
  for (const item of ['public', 'vendor']) fs.rmSync(path.join(SAIDA, item), { recursive: true, force: true });
  fs.cpSync(path.join(RAIZ, 'public'), path.join(SAIDA, 'public'), { recursive: true });
  for (const [origem, destino] of Object.entries(ARQUIVOS_VENDOR)) {
    fs.cpSync(path.join(RAIZ, origem), path.join(SAIDA, 'vendor', destino), { recursive: true });
  }
  fs.writeFileSync(path.join(SAIDA, 'LEIA-ME.txt'), leiaMe(), 'utf8');

  console.log('5/5 Compactando…');
  const zip = path.join(RAIZ, 'dist', 'MotoX-Servidor.zip');
  fs.rmSync(zip, { force: true });
  // o zip leva o programa, nunca o banco de dados de quem gerou
  execFileSync('tar', ['-a', '-c', '-f', zip, '--exclude', 'MotoX-Servidor/dados', 'MotoX-Servidor'], {
    cwd: path.join(RAIZ, 'dist'),
  });

  const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`\n✔ Pronto!\n  ${EXE} (${mb(EXE)})\n  ${zip} (${mb(zip)})`);
}

// Ícone e nome no exe são só aparência. O antivírus às vezes trava o arquivo recém-criado
// ("Unable to commit changes"): tenta de novo e, se não der, segue sem o ícone.
async function aplicarIcone(exe) {
  const { rcedit } = await import('rcedit');
  const opcoes = {
    icon: path.join(RAIZ, 'assets', 'icone.ico'),
    'version-string': {
      ProductName: 'MotoX',
      FileDescription: 'MotoX - Servidor de entregas por motoboy',
      CompanyName: 'MotoX',
      OriginalFilename: 'MotoX.exe',
      InternalName: 'MotoX',
      LegalCopyright: `(c) ${new Date().getFullYear()} MotoX`,
    },
    'file-version': pacote.version,
    'product-version': pacote.version,
  };
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    try {
      await rcedit(exe, opcoes);
      return;
    } catch (e) {
      if (tentativa === 4) {
        console.warn(`   aviso: não foi possível aplicar o ícone (${String(e.message).split('\n').pop()}). O exe funciona normalmente.`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * tentativa));
    }
  }
}

// Liga o exe numa porta livre e espera ele responder "MOTOX_OK" (o servidor sobe e se desliga sozinho)
function verificarExe(exe) {
  const pastaTeste = path.join(BUILD, 'teste-exe');
  fs.mkdirSync(pastaTeste, { recursive: true });
  const exeTeste = path.join(pastaTeste, 'MotoX.exe');
  fs.copyFileSync(exe, exeTeste);
  const r = spawnSync(exeTeste, [], {
    env: { ...process.env, MOTOX_VERIFICAR: '1', MOTOX_NAO_ABRIR: '1', PORT: String(40000 + Math.floor(Math.random() * 20000)) },
    encoding: 'utf8',
    timeout: 30000,
    input: '\n', // se der erro, o exe espera um Enter: isto evita travar aqui
  });
  if (!String(r.stdout).includes('MOTOX_OK')) {
    throw new Error(`O exe novo não ligou no teste.\n${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`);
  }
  console.log('   ✔ o exe novo liga e responde');
}

function leiaMe() {
  return `MotoX - Servidor  (versão ${pacote.version})
==============================

COMO USAR
1. Dê dois cliques em MotoX.exe.
2. Uma janela preta mostra os endereços do sistema e o navegador abre sozinho.
3. Deixe a janela aberta enquanto o sistema estiver em uso. Para desligar, feche-a.

PAINEL ADMINISTRATIVO
  Entre com o telefone e a senha de administrador definidos pelo responsável pelo sistema.

CELULARES NA MESMA REDE WI-FI
  Use o endereço "No celular (Wi-Fi)" mostrado na janela.
  Na primeira vez, o Windows pergunta se o MotoX pode usar a rede:
  marque "Redes privadas" e clique em Permitir.

AVISOS DO WINDOWS
  Por ser um programa novo e ainda sem assinatura digital, o Windows pode mostrar
  "O Windows protegeu o computador". Clique em "Mais informações" > "Executar assim mesmo".

SEUS DADOS
  Ficam na pasta "dados", ao lado do MotoX.exe. Para fazer backup, copie essa pasta
  com o programa fechado. Não apague a pasta: ela contém contas e corridas.

IMPORTANTE
  A pasta inteira é o programa: MotoX.exe precisa das pastas "public" e "vendor" ao lado.
`;
}

main().catch((e) => {
  console.error('\n✖ Falha ao gerar o executável:', e.message);
  process.exit(1);
});
