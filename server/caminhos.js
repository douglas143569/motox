// Onde ficam as páginas, as bibliotecas e o banco.
// - Desenvolvimento (npm start): tudo relativo à pasta do projeto.
// - MotoX.exe (scripts/gerar-exe.js): tudo ao lado do executável.
const path = require('path');

function empacotado() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

const EXE = empacotado();
const RAIZ = EXE ? path.dirname(process.execPath) : path.join(__dirname, '..');
const modulo = (p) => path.join(RAIZ, 'node_modules', p);

module.exports = {
  EXE,
  RAIZ,
  PUBLIC: path.join(RAIZ, 'public'),
  BANCO: path.join(RAIZ, 'dados', 'motox.db'),
  // documentos dos motoboys (CNH, CRLV): fora de public/, só o admin acessa pela API
  DOCUMENTOS: path.join(RAIZ, 'dados', 'documentos'),
  VENDOR: EXE
    ? {
        '/vendor': path.join(RAIZ, 'vendor'),
      }
    : {
        '/vendor/leaflet': modulo('leaflet/dist'),
        '/vendor/socket.io.min.js': modulo('socket.io/client-dist/socket.io.min.js'),
        '/vendor/capacitor.js': modulo('@capacitor/core/dist/capacitor.js'),
      },
  // origem -> destino dentro de vendor/ (usado para montar o exe e os apps)
  ARQUIVOS_VENDOR: {
    'node_modules/leaflet/dist': 'leaflet',
    'node_modules/socket.io/client-dist/socket.io.min.js': 'socket.io.min.js',
    'node_modules/@capacitor/core/dist/capacitor.js': 'capacitor.js',
  },
};
