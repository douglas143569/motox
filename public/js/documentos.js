// Anexo de documentos do motoboy (CNH e CRLV), usado no cadastro e no reenvio.
// Fotos são reduzidas e convertidas para JPEG no próprio aparelho antes de enviar.

const DOCS_INFO = {
  cnh: {
    icone: '🪪',
    titulo: 'Carteira de motorista (CNH)',
    ajuda: 'Foto legível da CNH aberta ou CNH digital em PDF. Precisa ter categoria A.',
  },
  crlv: {
    icone: '🏍️',
    titulo: 'Documento da moto (CRLV)',
    ajuda: 'Foto ou CRLV digital em PDF. A placa precisa ser a mesma informada no cadastro.',
  },
};
const LADO_MAX_FOTO = 1800; // px: legível para conferir os dados, sem pesar no envio
const TAMANHO_MAX_PDF = 6 * 1024 * 1024;

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.round(bytes / 1024)} KB`);

function lerComoDataURL(arquivo) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(arquivo);
  });
}

function carregarImagem(arquivo) {
  return new Promise((ok, falha) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => falha(new Error('Não consegui abrir esta imagem. Tire uma nova foto ou envie em PDF.'));
    img.src = url;
  });
}

async function prepararArquivo(arquivo) {
  const ehPdf = arquivo.type === 'application/pdf' || /\.pdf$/i.test(arquivo.name);
  if (ehPdf) {
    if (arquivo.size > TAMANHO_MAX_PDF) throw new Error('Este PDF passa de 6 MB. Envie uma foto do documento.');
    return { nome: arquivo.name, dados: await lerComoDataURL(arquivo), tamanho: arquivo.size, pdf: true };
  }
  if (!/^image\//.test(arquivo.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(arquivo.name)) {
    throw new Error('Envie uma foto ou um PDF do documento.');
  }
  const img = await carregarImagem(arquivo); // o navegador já aplica a rotação da foto do celular
  const escala = Math.min(1, LADO_MAX_FOTO / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * escala);
  canvas.height = Math.round(img.naturalHeight * escala);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; // PNG com transparência não vira fundo preto
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  if (canvas.width < 400 && canvas.height < 400) throw new Error('Esta imagem é pequena demais para ler o documento. Tire uma foto mais de perto.');
  const dados = canvas.toDataURL('image/jpeg', 0.85);
  return { nome: arquivo.name.replace(/\.\w+$/, '') + '.jpg', dados, tamanho: Math.round((dados.length - 23) * 0.75), previa: dados };
}

function campoDocumento(tipo) {
  const d = DOCS_INFO[tipo];
  return `<label class="doc" data-doc="${tipo}">
      <input type="file" accept="image/*,application/pdf" class="oculto">
      <span class="doc-previa">${d.icone}</span>
      <span class="cresce">
        <b>${d.titulo}</b>
        <small class="suave">${d.ajuda}</small>
        <small class="doc-estado">Toque para anexar foto ou PDF</small>
      </span>
    </label>`;
}

// estado: objeto que recebe { cnh: {nome, dados}, crlv: {...} } conforme a pessoa anexa
function ativarCamposDocumento(raiz, estado) {
  for (const campo of $$('.doc', raiz)) {
    const tipo = campo.dataset.doc;
    const input = $('input', campo);
    const estadoTexto = $('.doc-estado', campo);
    input.addEventListener('change', async () => {
      const arquivo = input.files && input.files[0];
      input.value = ''; // permite escolher o mesmo arquivo de novo
      if (!arquivo) return;
      campo.classList.remove('ok', 'erro');
      estadoTexto.textContent = 'Preparando…';
      try {
        const pronto = await prepararArquivo(arquivo);
        estado[tipo] = { nome: pronto.nome, dados: pronto.dados };
        $('.doc-previa', campo).innerHTML = pronto.previa ? `<img src="${pronto.previa}" alt="">` : '📄';
        estadoTexto.textContent = `✔ Anexado · ${pronto.pdf ? 'PDF' : 'foto'} · ${kb(pronto.tamanho)} · toque para trocar`;
        campo.classList.add('ok');
      } catch (e) {
        delete estado[tipo];
        estadoTexto.textContent = e.message;
        campo.classList.add('erro');
      }
    });
  }
}
