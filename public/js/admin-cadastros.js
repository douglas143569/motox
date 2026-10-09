// Análise do cadastro de motoboys no painel admin: ver CNH e CRLV, aprovar ou reprovar com motivo.

const SITUACAO_CADASTRO = {
  aprovado: ['Aprovado', 'ok'],
  pendente: ['Em análise', 'alerta'],
  reprovado: ['Reprovado', 'perigo'],
};
const seloCadastro = (s) => {
  const [t, cor] = SITUACAO_CADASTRO[s] || SITUACAO_CADASTRO.aprovado;
  return `<span class="selo ${cor}">${t}</span>`;
};

const NOME_DOCUMENTO = { cnh: 'Carteira de motorista (CNH)', crlv: 'Documento da moto (CRLV)' };
const MOTIVOS_COMUNS = [
  'Foto ilegível ou cortada. Envie uma foto nítida, com o documento inteiro.',
  'CNH vencida.',
  'A CNH não tem categoria A.',
  'A CNH não tem a observação EAR (exerce atividade remunerada).',
  'O nome da CNH é diferente do nome do cadastro.',
  'A placa do documento da moto é diferente da placa informada.',
  'Documento da moto (CRLV) vencido.',
];

let urlsAbertas = [];

// Os arquivos exigem login de admin, então vêm por fetch com o token e viram um endereço local temporário
async function baixarDocumento(id) {
  const resp = await fetch(`${MOTOX.servidor}/api/admin/documentos/${id}`, {
    headers: { Authorization: 'Bearer ' + Sessao.token },
  });
  if (!resp.ok) throw new Error('Não foi possível abrir o documento.');
  const url = URL.createObjectURL(await resp.blob());
  urlsAbertas.push(url);
  return url;
}

function fecharAnalise() {
  $('#modal-analise')?.classList.add('oculto');
  for (const u of urlsAbertas) URL.revokeObjectURL(u);
  urlsAbertas = [];
}

async function abrirAnalise(u) {
  let modal = $('#modal-analise');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-analise';
    modal.className = 'sobreposicao';
    modal.innerHTML = '<div class="oferta" style="max-width:640px;max-height:94dvh;overflow:auto"></div>';
    document.body.appendChild(modal);
  }
  const caixa = $('.oferta', modal);
  const docs = u.documentos || [];
  caixa.innerHTML = `
    <div class="linha entre"><h2 style="margin:0">Cadastro de ${esc(u.nome)}</h2>${seloCadastro(u.statusCadastro)}</div>
    <p class="suave peq" style="margin:4px 0 10px">${formatarTel(u.telefone)} · ${esc(u.moto || '')} · placa <b>${esc(u.placa || '')}</b>
      · cadastrado em ${new Date(u.criadoEm).toLocaleDateString('pt-BR')}</p>
    ${u.statusCadastro === 'reprovado' && u.motivoReprovacao ? `<div class="cartao peq" style="border:1px solid var(--perigo)">Último motivo de reprovação: ${esc(u.motivoReprovacao)}</div>` : ''}
    <div class="cartao peq">
      <b>Confira antes de aprovar:</b>
      <ul style="margin:6px 0 0;padding-left:18px">
        <li>Nome da CNH igual ao do cadastro (<b>${esc(u.nome)}</b>)</li>
        <li>CNH dentro da validade, <b>categoria A</b> e observação <b>EAR</b></li>
        <li>Placa do CRLV igual à informada (<b>${esc(u.placa || '')}</b>) e CRLV em dia</li>
      </ul>
    </div>
    <div id="docs-analise">
      ${['cnh', 'crlv']
        .map((tipo) => {
          const d = docs.find((x) => x.tipo === tipo);
          return `<div class="cartao">
            <div class="linha entre"><b>${NOME_DOCUMENTO[tipo]}</b>
              <small class="suave">${d ? `enviado em ${dataHora(d.enviadoEm)}` : 'não enviado'}</small></div>
            <div class="doc-visual" data-id="${d ? d.id : ''}" data-mime="${d ? esc(d.mime) : ''}" style="margin-top:8px">
              ${d ? '<small class="suave">Carregando…</small>' : '<small style="color:var(--perigo)">Este documento não foi enviado.</small>'}
            </div>
          </div>`;
        })
        .join('')}
    </div>
    <div id="area-reprovar" class="oculto">
      <h3>Motivo da reprovação</h3>
      <p class="suave peq" style="margin-top:0">O motoboy vai ler esta mensagem e poderá reenviar o documento corrigido.</p>
      <select class="input" id="motivo-comum" style="margin-bottom:8px">
        <option value="">Escolha um motivo comum…</option>
        ${MOTIVOS_COMUNS.map((m) => `<option>${esc(m)}</option>`).join('')}
      </select>
      <textarea class="input" id="motivo-texto" maxlength="300" placeholder="Ou escreva o motivo"></textarea>
    </div>
    <div class="linha" style="margin-top:12px;flex-wrap:wrap">
      <button class="btn contorno" id="an-fechar">Fechar</button>
      <button class="btn perigo cresce" id="an-reprovar">Reprovar</button>
      <button class="btn ok cresce" id="an-aprovar" ${docs.length < 2 ? 'disabled title="Faltam documentos"' : ''}>Aprovar</button>
    </div>`;
  modal.classList.remove('oculto');

  $('#an-fechar').addEventListener('click', fecharAnalise);
  $('#motivo-comum').addEventListener('change', (e) => e.target.value && ($('#motivo-texto').value = e.target.value));
  $('#an-aprovar').addEventListener('click', (e) => decidir(u, true, e.currentTarget));
  $('#an-reprovar').addEventListener('click', (e) => {
    const area = $('#area-reprovar');
    if (area.classList.contains('oculto')) {
      area.classList.remove('oculto');
      e.currentTarget.textContent = 'Confirmar reprovação';
      $('#motivo-comum').focus();
      return;
    }
    decidir(u, false, e.currentTarget);
  });

  // carrega as imagens/PDFs
  for (const el of $$('.doc-visual[data-id]', caixa)) {
    if (!el.dataset.id) continue;
    try {
      const url = await baixarDocumento(el.dataset.id);
      el.innerHTML =
        el.dataset.mime === 'application/pdf'
          ? `<button class="btn contorno peq" type="button">📄 Abrir PDF</button>`
          : `<img src="${url}" alt="Documento" style="width:100%;max-height:420px;object-fit:contain;border-radius:10px;background:#000;cursor:zoom-in">
             <small class="suave">Toque na imagem para ampliar.</small>`;
      $('button, img', el).addEventListener('click', () => window.open(url, '_blank'));
    } catch (erro) {
      el.innerHTML = `<small style="color:var(--perigo)">${esc(erro.message)}</small>`;
    }
  }
}

async function decidir(u, aprovar, botao) {
  const motivo = aprovar ? '' : $('#motivo-texto').value.trim();
  if (!aprovar && motivo.length < 3) {
    toast('Escreva ou escolha o motivo da reprovação.', 'erro');
    return $('#motivo-texto').focus();
  }
  if (aprovar && !confirm(`Aprovar ${u.nome}? Ele poderá ficar online e receber corridas.`)) return;
  await acao(botao, async () => {
    await api(`/admin/usuarios/${u.id}/analise`, { metodo: 'POST', corpo: { aprovar, motivo } });
    fecharAnalise();
    toast(aprovar ? `${u.nome} aprovado. Ele já foi avisado no app.` : `Cadastro reprovado. ${u.nome} foi avisado do motivo.`, 'ok');
    carregarContas();
    carregar();
  });
}
