// Abas "Tarifas" e "Promoções" do painel admin.
// Na tela, multiplicadores aparecem como porcentagem de acréscimo (1,25 -> +25%), que é como o dono do negócio pensa.

const paraPct = (mult) => Math.round((mult - 1) * 1000) / 10;
const dePct = (pct) => 1 + Number(pct) / 100;
const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const NOMES_DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const textoDinamica = (d) =>
  d.mult > 1 ? `<span style="color:var(--marca)">+${paraPct(d.mult)}% · ${esc(d.motivos.join(' + '))}</span>` : 'Tarifa normal';

function campoNum(id, rotulo, valor, { passo = '0.01', min = 0, ajuda = '' } = {}) {
  return `<label class="campo"><span>${rotulo}</span>
    <input class="input" type="number" inputmode="decimal" step="${passo}" min="${min}" id="${id}" value="${valor}">
    ${ajuda ? `<small class="suave">${ajuda}</small>` : ''}</label>`;
}

// ===================== TARIFAS =====================

let tarifasInfo = null; // { tarifas, padrao, agora, alteracao }
let faixasRascunho = [];
let alterado = false;

async function abrirTarifas() {
  const sec = $('#aba-tarifas');
  sec.innerHTML = '<p class="suave" style="margin-top:14px">Carregando…</p>';
  try {
    tarifasInfo = await api('/admin/tarifas');
    renderTarifas(tarifasInfo.tarifas);
  } catch (e) {
    sec.innerHTML = `<p class="suave">${esc(e.message)}</p>`;
  }
}

function renderTarifas(t) {
  const { agora, alteracao } = tarifasInfo;
  const d = t.dinamica;
  faixasRascunho = JSON.parse(JSON.stringify(d.faixas));
  const sec = $('#aba-tarifas');
  sec.innerHTML = `
    <div class="bloco-adm linha entre" style="margin-top:14px;flex-wrap:wrap">
      <div><b>Agora:</b> ${textoDinamica(agora)}</div>
      <small class="suave">${alteracao ? `Última alteração por ${esc(alteracao.por || '—')} em ${dataHora(alteracao.em)}` : 'Usando os valores padrão'}</small>
    </div>

    <div class="grade-tarifas">
      <div class="bloco-adm">
        <h3>Preço da corrida</h3>
        <div class="grade-campos">
          ${campoNum('t-base', 'Bandeirada (R$)', t.base)}
          ${campoNum('t-porKm', 'Por km (R$)', t.porKm)}
          ${campoNum('t-minimo', 'Valor mínimo (R$)', t.minimo)}
          ${campoNum('t-distMax', 'Distância máxima (km)', t.distanciaMaxKm, { passo: '1', min: 1 })}
        </div>
        <p class="suave peq" style="margin:0">Preço = bandeirada + km × valor por km (nunca abaixo do mínimo), arredondado para cima em R$ 0,50.</p>
      </div>

      <div class="bloco-adm">
        <h3>Comissão e acréscimos</h3>
        <div class="grade-campos">
          ${campoNum('t-taxa', 'Comissão MotoX (%)', Math.round(t.taxaPlataforma * 1000) / 10, { passo: '0.5', ajuda: `<span id="ajuda-taxa"></span>` })}
          ${campoNum('t-idaVolta', 'Ida e volta (+%)', paraPct(t.idaVolta), { passo: '1' })}
          ${Object.entries(t.tamanhos).map(([k, z]) => campoNum(`t-tam-${k}`, `${esc(z.nome)} (+%)`, paraPct(z.mult), { passo: '1', min: -50 })).join('')}
        </div>
      </div>

      <div class="bloco-adm">
        <h3>Tarifa dinâmica</h3>
        <label class="alternar">
          <span><b>🌧️ Modo chuva</b><br><small class="suave">Ligue quando começar a chover. O cliente vê o motivo do acréscimo.</small></span>
          <span class="chave"><input type="checkbox" id="t-chuva" ${d.chuva.ativo ? 'checked' : ''}><span></span></span>
        </label>
        <div class="grade-campos">
          ${campoNum('t-chuvaPct', 'Acréscimo da chuva (+%)', paraPct(d.chuva.mult), { passo: '1' })}
          ${campoNum('t-teto', 'Teto do acréscimo (+%)', paraPct(d.teto), { passo: '1', ajuda: 'Somando tudo, nunca passa disto' })}
          ${campoNum('t-repasse', 'Repasse ao motoboy (%)', Math.round(d.repasseMotoboy * 100), { passo: '5', ajuda: 'Quanto do acréscimo vai para o motoboy' })}
        </div>
        <h3>Horários de pico</h3>
        <p class="suave peq" style="margin-top:0">Horário de Brasília. Se dois horários coincidirem, vale o maior; a chuva soma por cima.</p>
        <div id="faixas"></div>
        <button class="btn contorno peq" id="btn-add-faixa">+ Adicionar horário</button>
      </div>

      <div class="bloco-adm">
        <h3>Simulador</h3>
        <p class="suave peq" style="margin-top:0">Mostra o efeito dos valores acima <b>antes</b> de salvar.</p>
        <div class="grade-campos">
          ${campoNum('s-km', 'Distância (km)', 5, { passo: '0.5', min: 0.5 })}
          <label class="campo"><span>Tamanho</span><select class="input" id="s-tam">
            ${Object.entries(t.tamanhos).map(([k, z]) => `<option value="${k}">${esc(z.nome)}</option>`).join('')}
          </select></label>
        </div>
        <label class="alternar"><span>Ida e volta</span><span class="chave"><input type="checkbox" id="s-iv"><span></span></span></label>
        <label class="alternar"><span>Com a tarifa dinâmica de agora</span><span class="chave"><input type="checkbox" id="s-din" checked><span></span></span></label>
        <div id="simulacao" class="opcoes"></div>
        <div id="simulacao-extra" class="suave peq" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="rodape-adm">
      <button class="btn contorno peq" id="btn-padrao">Restaurar padrão</button>
      <button class="btn contorno peq" id="btn-desfazer">Desfazer</button>
      <button class="btn primario cresce" id="btn-salvar-tarifas">Salvar alterações</button>
    </div>`;

  renderFaixas();
  marcarAlterado(false);
  sec.oninput = sec.onchange = () => {
    marcarAlterado(true);
    agendarSimulacao();
  };
  $('#btn-add-faixa').addEventListener('click', () => {
    lerFaixas();
    faixasRascunho.push({ nome: 'Novo horário', dias: [1, 2, 3, 4, 5], inicio: '18:00', fim: '20:00', mult: 1.1, ativo: true });
    renderFaixas();
    marcarAlterado(true);
    agendarSimulacao();
  });
  $('#btn-salvar-tarifas').addEventListener('click', (e) => salvarTarifas(e.currentTarget));
  $('#btn-desfazer').addEventListener('click', () => renderTarifas(tarifasInfo.tarifas));
  $('#btn-padrao').addEventListener('click', () => {
    renderTarifas(tarifasInfo.padrao);
    marcarAlterado(true);
    toast('Valores padrão carregados. Clique em Salvar para aplicar.');
  });
  simular();
}

function renderFaixas() {
  const box = $('#faixas');
  box.innerHTML = faixasRascunho.length
    ? faixasRascunho
        .map(
          (f, i) => `<div class="faixa" data-i="${i}">
            <div class="linha">
              <span class="chave" title="Ligado/desligado"><input type="checkbox" class="f-ativo" ${f.ativo ? 'checked' : ''}><span></span></span>
              <input class="input f-nome cresce" value="${esc(f.nome)}" maxlength="40" aria-label="Nome do horário">
              <button class="btn-icone f-remover" title="Remover" aria-label="Remover" style="box-shadow:none">🗑️</button>
            </div>
            <div class="dias">${DIAS.map((l, d) => `<button type="button" class="${f.dias.includes(d) ? 'sel' : ''}" data-dia="${d}" title="${NOMES_DIAS[d]}">${l}</button>`).join('')}</div>
            <div class="grade-campos">
              <label class="campo"><span>Início</span><input class="input f-inicio" type="time" value="${f.inicio}"></label>
              <label class="campo"><span>Fim</span><input class="input f-fim" type="time" value="${f.fim}"></label>
              <label class="campo"><span>Acréscimo (+%)</span><input class="input f-pct" type="number" step="1" min="0" value="${paraPct(f.mult)}"></label>
            </div>
          </div>`
        )
        .join('')
    : '<p class="suave peq">Nenhum horário de pico cadastrado.</p>';
  for (const el of $$('.faixa', box)) {
    const i = Number(el.dataset.i);
    $('.f-remover', el).addEventListener('click', () => {
      lerFaixas();
      faixasRascunho.splice(i, 1);
      renderFaixas();
      marcarAlterado(true);
      agendarSimulacao();
    });
    for (const b of $$('.dias button', el)) {
      b.addEventListener('click', () => {
        b.classList.toggle('sel');
        marcarAlterado(true);
        agendarSimulacao();
      });
    }
  }
}

function lerFaixas() {
  faixasRascunho = $$('#faixas .faixa').map((el) => ({
    nome: $('.f-nome', el).value,
    ativo: $('.f-ativo', el).checked,
    dias: $$('.dias button.sel', el).map((b) => Number(b.dataset.dia)),
    inicio: $('.f-inicio', el).value,
    fim: $('.f-fim', el).value,
    mult: dePct($('.f-pct', el).value),
  }));
  return faixasRascunho;
}

function lerTarifas() {
  const v = (id) => Number($(`#${id}`).value);
  const base = tarifasInfo.tarifas;
  return {
    base: v('t-base'),
    porKm: v('t-porKm'),
    minimo: v('t-minimo'),
    distanciaMaxKm: v('t-distMax'),
    taxaPlataforma: Math.round(v('t-taxa') * 10) / 1000,
    idaVolta: dePct(v('t-idaVolta')),
    tamanhos: Object.fromEntries(Object.keys(base.tamanhos).map((k) => [k, { mult: dePct(v(`t-tam-${k}`)) }])),
    dinamica: {
      chuva: { ativo: $('#t-chuva').checked, mult: dePct(v('t-chuvaPct')) },
      teto: dePct(v('t-teto')),
      repasseMotoboy: v('t-repasse') / 100,
      faixas: lerFaixas(),
    },
  };
}

function marcarAlterado(sim) {
  alterado = sim;
  const b = $('#btn-salvar-tarifas');
  if (b) b.textContent = sim ? 'Salvar alterações •' : 'Salvar alterações';
  const taxa = Number($('#t-taxa')?.value);
  if ($('#ajuda-taxa')) $('#ajuda-taxa').textContent = Number.isFinite(taxa) ? `Motoboy fica com ${Math.round((100 - taxa) * 10) / 10}%` : '';
}

let timerSim = null;
function agendarSimulacao() {
  clearTimeout(timerSim);
  timerSim = setTimeout(simular, 300);
}

async function simular() {
  const box = $('#simulacao');
  if (!box) return;
  try {
    const r = await api('/admin/tarifas/simular', {
      metodo: 'POST',
      corpo: {
        tarifas: lerTarifas(),
        distanciaKm: Number($('#s-km').value),
        tamanho: $('#s-tam').value,
        idaVolta: $('#s-iv').checked,
        comDinamica: $('#s-din').checked,
      },
    });
    box.innerHTML = [
      ['Cliente paga', r.preco, ''],
      ['Motoboy recebe', r.ganhoMotoboy, 'color:var(--ok)'],
      ['MotoX fica', r.taxaPlataforma, 'color:var(--marca)'],
    ]
      .map(([t, v, cor]) => `<div class="opcao"><small>${t}</small><b style="${cor}">${brl(v)}</b></div>`)
      .join('');
    $('#simulacao-extra').innerHTML = r.adicionalDinamico
      ? `Inclui acréscimo de ${brl(r.adicionalDinamico)} (${esc(r.motivosDinamica.join(' + '))}) sobre o preço base de ${brl(r.precoBase)}.`
      : '';
  } catch (e) {
    box.innerHTML = `<p class="peq" style="color:var(--perigo);grid-column:1/-1">${esc(e.message)}</p>`;
    $('#simulacao-extra').innerHTML = '';
  }
}

async function salvarTarifas(botao) {
  if (!confirm('As novas tarifas passam a valer imediatamente para os próximos pedidos. Salvar?')) return;
  await acao(botao, async () => {
    const r = await api('/admin/tarifas', { metodo: 'POST', corpo: { tarifas: lerTarifas() } });
    tarifasInfo = { ...tarifasInfo, ...r };
    renderTarifas(r.tarifas);
    toast('Tarifas salvas e já em vigor.', 'ok');
    if (typeof carregar === 'function') carregar();
  });
}

// ===================== PROMOÇÕES =====================

const SITUACAO = {
  ativa: ['Ativa', 'ok'],
  agendada: ['Agendada', 'info'],
  pausada: ['Pausada', ''],
  encerrada: ['Encerrada', 'perigo'],
  esgotada: ['Esgotada', 'perigo'],
};

// Modelos baseados no que os apps do segmento mais usam
const MODELOS = {
  'Boas-vindas': {
    codigo: 'BEMVINDO', descricao: '20% de desconto na sua primeira entrega', tipo: 'percentual', valor: 20,
    descontoMax: 15, soPrimeiraCorrida: true, automatica: true, limitePorCliente: 1,
  },
  'Campanha %': {
    codigo: 'MOTOX10', descricao: '10% de desconto na entrega', tipo: 'percentual', valor: 10, descontoMax: 10,
    limitePorCliente: 1, limiteTotal: 100, fim: Date.now() + 30 * 864e5,
  },
  'R$ fixo': {
    codigo: 'MENOS5', descricao: 'R$ 5 de desconto em entregas acima de R$ 25', tipo: 'fixo', valor: 5,
    pedidoMinimo: 25, limitePorCliente: 3,
  },
};

let promocoes = [];

async function abrirPromocoes() {
  const sec = $('#aba-promocoes');
  sec.innerHTML = '<p class="suave" style="margin-top:14px">Carregando…</p>';
  try {
    const r = await api('/admin/promocoes');
    promocoes = r.promocoes;
    renderPromocoes(r.mes);
  } catch (e) {
    sec.innerHTML = `<p class="suave">${esc(e.message)}</p>`;
  }
}

function regrasPromo(p) {
  const r = [p.tipo === 'percentual' ? `${p.valor}% de desconto` : `${brl(p.valor)} de desconto`];
  if (p.descontoMax) r.push(`até ${brl(p.descontoMax)}`);
  if (p.pedidoMinimo) r.push(`pedido mín. ${brl(p.pedidoMinimo)}`);
  if (p.soPrimeiraCorrida) r.push('só 1ª entrega');
  if (p.limitePorCliente) r.push(`${p.limitePorCliente}× por cliente`);
  if (p.automatica) r.push('automática');
  return r.join(' · ');
}

const dataCurta = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

function renderPromocoes(mes) {
  const ativas = promocoes.filter((p) => p.situacao === 'ativa').length;
  $('#aba-promocoes').innerHTML = `
    <div class="kpis">
      <div class="kpi"><small>Descontos no mês</small><b>${brl(mes.total)}</b></div>
      <div class="kpi"><small>Entregas com cupom no mês</small><b>${mes.corridas}</b></div>
      <div class="kpi"><small>Promoções ativas</small><b>${ativas}</b></div>
    </div>
    <div class="bloco-adm" style="margin-bottom:12px">
      <div class="linha entre" style="flex-wrap:wrap;gap:8px">
        <div><b>Nova promoção</b><div class="suave peq">O desconto sai da parte da MotoX: o ganho do motoboy não muda.</div></div>
        <button class="btn primario peq" id="btn-nova-promo">+ Criar do zero</button>
      </div>
      <div class="filtros" style="margin-bottom:0">
        <span class="suave peq" style="align-self:center">Modelos:</span>
        ${Object.keys(MODELOS).map((m) => `<button class="opcao" data-modelo="${esc(m)}">${esc(m)}</button>`).join('')}
      </div>
    </div>
    <ul class="contas" id="lista-promos">
      ${promocoes.length ? promocoes.map(cartaoPromo).join('') : '<li class="suave">Nenhuma promoção criada ainda. Comece por um modelo acima.</li>'}
    </ul>`;

  $('#btn-nova-promo').addEventListener('click', () => abrirFormPromo({ tipo: 'percentual', ativo: true }));
  for (const b of $$('[data-modelo]')) b.addEventListener('click', () => abrirFormPromo({ ...MODELOS[b.dataset.modelo], ativo: true }));
  $('#lista-promos').addEventListener('click', aoClicarPromo);
}

function cartaoPromo(p) {
  const [sit, cor] = SITUACAO[p.situacao];
  const validade =
    p.inicio || p.fim ? `${p.inicio ? 'de ' + dataCurta(p.inicio) : ''} ${p.fim ? 'até ' + dataCurta(p.fim) : ''}`.trim() : 'sem prazo';
  return `<li class="conta ${p.situacao === 'pausada' ? 'bloqueada' : ''}">
    <div class="linha entre">
      <b style="font-size:1.1rem;letter-spacing:1px">${esc(p.codigo)}</b>
      <span class="selo ${cor}">${sit}</span>
    </div>
    <div style="margin-top:4px">${esc(p.descricao)}</div>
    <div class="detalhes">${regrasPromo(p)}</div>
    <div class="detalhes">Validade: ${validade}</div>
    <div class="detalhes">Usos: <b>${p.usos}</b>${p.limiteTotal ? ` de ${p.limiteTotal}` : ''} · Descontado: <b>${brl(p.totalDescontado)}</b></div>
    <div class="acoes">
      <button class="btn contorno peq" data-editar="${p.id}">Editar</button>
      <button class="btn contorno peq" data-alternar="${p.id}">${p.ativo ? 'Pausar' : 'Ativar'}</button>
      <button class="btn perigo peq" data-apagar="${p.id}">Excluir</button>
    </div>
  </li>`;
}

async function aoClicarPromo(e) {
  const alvo = e.target.closest('button');
  if (!alvo) return;
  const id = Number(alvo.dataset.editar || alvo.dataset.alternar || alvo.dataset.apagar);
  const p = promocoes.find((x) => x.id === id);
  if (!p) return;
  if (alvo.dataset.editar) return abrirFormPromo(p);
  if (alvo.dataset.alternar) {
    return acao(alvo, async () => {
      await api(`/admin/promocoes/${id}/ativo`, { metodo: 'POST', corpo: { ativo: !p.ativo } });
      toast(p.ativo ? 'Promoção pausada.' : 'Promoção ativada.', 'ok');
      abrirPromocoes();
    });
  }
  if (alvo.dataset.apagar) {
    if (!confirm(`Excluir a promoção ${p.codigo}?`)) return;
    return acao(alvo, async () => {
      await api(`/admin/promocoes/${id}`, { metodo: 'DELETE' });
      toast('Promoção excluída.', 'ok');
      abrirPromocoes();
    });
  }
}

// datetime-local trabalha no fuso do navegador
const paraCampoData = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const deCampoData = (v) => (v ? new Date(v).getTime() : null);

function abrirFormPromo(p) {
  let modal = $('#modal-promo');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-promo';
    modal.className = 'sobreposicao';
    modal.innerHTML = '<div class="oferta" style="max-height:92dvh;overflow:auto"></div>';
    document.body.appendChild(modal);
  }
  const caixa = $('.oferta', modal);
  const alternar = (id, rotulo, ajuda, marcado) => `<label class="alternar">
      <span><b>${rotulo}</b><br><small class="suave">${ajuda}</small></span>
      <span class="chave"><input type="checkbox" id="${id}" ${marcado ? 'checked' : ''}><span></span></span></label>`;
  const valorOuVazio = (v) => (v == null ? '' : v);

  caixa.innerHTML = `
    <h2 style="margin-top:0">${p.id ? 'Editar promoção' : 'Nova promoção'}</h2>
    <div class="grade-campos">
      <label class="campo"><span>Código</span><input class="input" id="p-codigo" maxlength="20" value="${esc(p.codigo || '')}" style="text-transform:uppercase" placeholder="EX.: MOTOX10"></label>
      <label class="campo"><span>Tipo de desconto</span><select class="input" id="p-tipo">
        <option value="percentual" ${p.tipo !== 'fixo' ? 'selected' : ''}>Porcentagem (%)</option>
        <option value="fixo" ${p.tipo === 'fixo' ? 'selected' : ''}>Valor fixo (R$)</option>
      </select></label>
    </div>
    <label class="campo"><span>Descrição (o cliente vê)</span><input class="input" id="p-descricao" maxlength="80" value="${esc(p.descricao || '')}" placeholder="Ex.: 10% de desconto na entrega"></label>
    <div class="grade-campos">
      <label class="campo"><span id="rotulo-valor">Desconto</span><input class="input" id="p-valor" type="number" step="0.01" min="0" value="${valorOuVazio(p.valor)}"></label>
      <label class="campo" id="campo-max"><span>Desconto máximo (R$)</span><input class="input" id="p-max" type="number" step="0.5" min="0" value="${valorOuVazio(p.descontoMax)}" placeholder="sem limite"></label>
      <label class="campo"><span>Pedido mínimo (R$)</span><input class="input" id="p-minimo" type="number" step="0.5" min="0" value="${valorOuVazio(p.pedidoMinimo)}" placeholder="nenhum"></label>
    </div>
    <div class="grade-campos">
      <label class="campo"><span>Começa em</span><input class="input" id="p-inicio" type="datetime-local" value="${paraCampoData(p.inicio)}"></label>
      <label class="campo"><span>Termina em</span><input class="input" id="p-fim" type="datetime-local" value="${paraCampoData(p.fim)}"></label>
    </div>
    <div class="grade-campos">
      <label class="campo"><span>Limite total de usos</span><input class="input" id="p-limite" type="number" step="1" min="0" value="${valorOuVazio(p.limiteTotal)}" placeholder="ilimitado"></label>
      <label class="campo"><span>Usos por cliente</span><input class="input" id="p-porcliente" type="number" step="1" min="0" value="${valorOuVazio(p.limitePorCliente)}" placeholder="ilimitado"></label>
    </div>
    ${alternar('p-primeira', 'Só na primeira entrega', 'Para conquistar clientes novos', p.soPrimeiraCorrida)}
    ${alternar('p-auto', 'Aplicar automaticamente', 'O cliente não precisa digitar o código (ex.: boas-vindas)', p.automatica)}
    ${alternar('p-ativo', 'Promoção ativa', 'Desligue para pausar sem apagar', p.ativo !== false)}
    <div class="linha" style="margin-top:10px">
      <button class="btn contorno cresce" id="p-cancelar">Cancelar</button>
      <button class="btn primario cresce" id="p-salvar">${p.id ? 'Salvar' : 'Criar promoção'}</button>
    </div>`;
  modal.classList.remove('oculto');

  const ajustarTipo = () => {
    const pct = $('#p-tipo').value === 'percentual';
    $('#rotulo-valor').textContent = pct ? 'Desconto (%)' : 'Desconto (R$)';
    $('#campo-max').classList.toggle('oculto', !pct);
  };
  ajustarTipo();
  $('#p-tipo').addEventListener('change', ajustarTipo);
  $('#p-cancelar').addEventListener('click', () => modal.classList.add('oculto'));
  $('#p-salvar').addEventListener('click', (e) =>
    acao(e.currentTarget, async () => {
      const corpo = {
        codigo: $('#p-codigo').value,
        descricao: $('#p-descricao').value,
        tipo: $('#p-tipo').value,
        valor: $('#p-valor').value,
        descontoMax: $('#p-tipo').value === 'percentual' ? $('#p-max').value : '',
        pedidoMinimo: $('#p-minimo').value,
        inicio: deCampoData($('#p-inicio').value),
        fim: deCampoData($('#p-fim').value),
        limiteTotal: $('#p-limite').value,
        limitePorCliente: $('#p-porcliente').value,
        soPrimeiraCorrida: $('#p-primeira').checked,
        automatica: $('#p-auto').checked,
        ativo: $('#p-ativo').checked,
      };
      await api(p.id ? `/admin/promocoes/${p.id}` : '/admin/promocoes', { metodo: 'POST', corpo });
      modal.classList.add('oculto');
      toast(p.id ? 'Promoção atualizada.' : 'Promoção criada.', 'ok');
      abrirPromocoes();
    })
  );
}
