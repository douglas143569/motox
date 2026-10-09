// Gera o conteúdo web dos apps Capacitor a partir de public/ e sincroniza com Android/iOS.
//
//   node scripts/montar-apps.js                      -> usa o IP desta máquina na rede (teste no Wi-Fi)
//   node scripts/montar-apps.js https://api.motox.com.br  -> servidor de produção
//
// O endereço também pode vir da variável MOTOX_SERVIDOR.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PORTA = process.env.PORT || 3000;

const APPS = {
  cliente: {
    appId: 'br.com.motox.cliente',
    appName: 'MotoX',
    paginas: ['index.html', 'cliente.html'],
  },
  entregador: {
    appId: 'br.com.motox.entregador',
    appName: 'MotoX Entregador',
    paginas: ['index.html', 'motoboy.html'],
  },
};

const { ARQUIVOS_VENDOR } = require('../server/caminhos');

function ipDaRede() {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
  // prefere as faixas típicas de Wi-Fi doméstico/escritório
  return ips.find((ip) => ip.startsWith('192.168.')) || ips.find((ip) => ip.startsWith('10.')) || ips[0];
}

const servidor = (process.argv[2] || process.env.MOTOX_SERVIDOR || `http://${ipDaRede()}:${PORTA}`).replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(servidor)) {
  console.error(`Endereço de servidor inválido: ${servidor}`);
  process.exit(1);
}
const ehHttp = servidor.startsWith('http://');

const copiar = (de, para) => fs.cpSync(path.join(RAIZ, de), para, { recursive: true });

for (const [nome, app] of Object.entries(APPS)) {
  const dirApp = path.join(RAIZ, 'apps', nome);
  const www = path.join(dirApp, 'www');
  fs.rmSync(www, { recursive: true, force: true });
  fs.mkdirSync(www, { recursive: true });

  for (const pagina of app.paginas) copiar(`public/${pagina}`, path.join(www, pagina));
  for (const pasta of ['css', 'js']) copiar(`public/${pasta}`, path.join(www, pasta));
  for (const arq of ['icone.svg', 'manifest.webmanifest']) copiar(`public/${arq}`, path.join(www, arq));
  for (const [origem, destino] of Object.entries(ARQUIVOS_VENDOR)) copiar(origem, path.join(www, 'vendor', destino));

  fs.writeFileSync(
    path.join(www, 'js', 'config.js'),
    `// Gerado por scripts/montar-apps.js — não edite.\nwindow.MOTOX = ${JSON.stringify({ servidor, app: nome })};\n`
  );

  const capConfig = {
    appId: app.appId,
    appName: app.appName,
    webDir: 'www',
    // Servidor em http (teste na rede local): a página do app também precisa ser http,
    // senão o Android bloqueia as chamadas por "conteúdo misto".
    server: ehHttp ? { androidScheme: 'http', cleartext: true } : { androidScheme: 'https' },
  };
  fs.writeFileSync(path.join(dirApp, 'capacitor.config.json'), JSON.stringify(capConfig, null, 2) + '\n');

  for (const plataforma of ['android', 'ios']) {
    if (fs.existsSync(path.join(dirApp, plataforma))) {
      execSync(`npx cap sync ${plataforma}`, { cwd: dirApp, stdio: 'inherit' });
    }
  }
  console.log(`✔ ${app.appName} (${app.appId}) montado`);
}

console.log(`\nServidor configurado nos apps: ${servidor}`);
if (ehHttp) console.log('Atenção: http só serve para teste. Para publicar nas lojas, use um servidor com https.');
