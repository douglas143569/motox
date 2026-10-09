const usuario = exigirLogin('cliente');
const mapa = criarMapa('mapa');
const painel = $('#painel');
const sock = conectarSocket();

const pedido = {
  origem: null,
  destino: null,
  tamanho: 'pequeno',
  idaVolta: false,
  pagamento: 'pix',
  observacoes: '',
  destinatarioNome: '',
  destinatarioTel: '',
  cupom: '',
};
let config = { tamanhos: {}, pagamentos: [] };
let campoAtivo = 'origem';
let cotacao = null;
let seqCotacao = 0;
let corrida = null;
const camadas = { origem: null, destino: null, rota: null, moto: null };

// ---------- mapa ----------

function enquadrar() {
  const pontos = [];
  for (const k of ['origem', 'destino', 'moto']) if (camadas[k]) pontos.push(camadas[k].getLatLng());
  if (camadas.rota) pontos.push(...camadas.rota.getLatLngs());
  if (!pontos.length) return;
  if (pontos.length === 1) return mapa.setView(pontos[0], 16);
  const desktop = innerWidth >= 900;
  mapa.fitBounds(L.latLngBounds(pontos), {
    paddingTopLeft: desktop ? [440, 40] : [30, 80],
    paddingBottomRight: desktop ? [40, 40] : [30, Math.min(painel.offsetHeight, innerHeight * 0.6) + 20],
    maxZoom: 16,
  });
}

function marcarPonto(tipo, p, arrastavel = false) {
  if (camadas[tipo]) camadas[tipo].remove();
  camadas[tipo] = null;
  if (!p) return;
  camadas[tipo] = L.marker([p.lat, p.lng], { icon: ICONES[tipo](), draggable: arrastavel }).addTo(mapa);
  if (arrastavel) {
    camadas[tipo].on('dragend', async (e) => {
      const { lat, lng } = e.target.getLatLng();
      definirPonto(tipo, await api(`/geo/reverso?lat=${lat}&lng=${lng}`));
    });
  }
}

function desenharRota(geometria) {
  if (camadas.rota) camadas.rota.remove();
  camadas.rota = geometria ? L.polyline(geometria, { color: '#141414', weight: 5, opacity: 0.85 }).addTo(mapa) : null;
}

function moverMoto(pos) {
  if (!pos) return;
  if (!camadas.moto) camadas.moto = L.marker([pos.lat, pos.lng], { icon: ICONES.moto(), zIndexOffset: 1000 }).addTo(mapa);
  else animarMarcador(camadas.moto, [pos.lat, pos.lng]);
  atualizarEta(pos);
}

function limparMapa() {
  for (const k of Object.keys(camadas)) {
    if (camadas[k]) camadas[k].remove();
    camadas[k] = null;
  }
}

// ---------- tela: novo pedido ----------

function telaPedido() {
  corrida = null;
  limparMapa();
  painel.innerHTML = `
    <h2>Olá, ${esc(usuario.nome.split(' ')[0])}! O que vamos levar?</h2>
    <div class="enderecos">
      <div class="end-linha" data-campo="origem">
        <span class="ponto origem"></span>
        <input id="in-origem" placeholder="Endereço de coleta" autocomplete="off" enterkeyhint="search">
        <button class="btn-icone" id="btn-gps" style="box-shadow:none;background:transparent;width:38px;height:38px" title="Usar minha localização" aria-label="Usar minha localização">📍</button>
      </div>
      <div class="end-linha" data-campo="destino">
        <span class="ponto destino"></span>
        <input id="in-destino" placeholder="Endereço de entrega" autocomplete="off" enterkeyhint="search">
      </div>
    </div>
    <ul class="sugestoes oculto" id="sugestoes"></ul>
    <p class="dica-mapa" id="dica"></p>

    <div id="opcoes-pedido" class="oculto">
      <h3>Tamanho do pacote</h3>
      <div class="opcoes" id="tamanhos">
        ${Object.entries(config.tamanhos)
          .map(([k, t]) => `<button class="opcao" data-tamanho="${k}"><b>${esc(t.nome)}</b><small>${esc(t.desc)}</small></button>`)
          .join('')}
      </div>
      <label class="alternar">
        <span><b>Ida e volta</b><br><small class="suave">O motoboy volta à coleta (ex.: trazer assinatura)</small></span>
        <span class="chave"><input type="checkbox" id="ida-volta"><span></span></span>
      </label>
      <h3>Pagamento</h3>
      <div class="opcoes" id="pagamentos">
        ${config.pagamentos.map((p) => `<button class="opcao" data-pagamento="${p}"><b>${PAGAMENTO_TEXTO[p]}</b></button>`).join('')}
      </div>
      <details class="mais">
        <summary>Quem recebe e observações (opcional)</summary>
        <label class="campo"><span>Nome de quem recebe</span><input class="input" id="dest-nome" maxlength="80"></label>
        <label class="campo"><span>Celular de quem recebe</span><input class="input" id="dest-tel" type="tel" inputmode="tel"></label>
        <label class="campo"><span>Observações para o motoboy</span><textarea class="input" id="obs" maxlength="300" placeholder="Ex.: retirar na portaria, apto 42"></textarea></label>
      </details>
      <details class="mais" id="bloco-cupom">
        <summary>🏷️ Tenho um cupom de desconto</summary>
        <div class="linha">
          <input class="input cresce" id="cupom" placeholder="Código do cupom" maxlength="20" autocomplete="off" style="text-transform:uppercase">
          <button class="btn contorno peq" id="btn-cupom" style="min-height:50px">Aplicar</button>
        </div>
      </details>
      <div class="rodape-fixo">
        <div class="peq" id="resumo-extra"></div>
        <div class="resumo-preco">
          <div><div class="suave peq" id="resumo-info">Calculando…</div><div class="peq" id="resumo-motoboys"></div></div>
          <div class="valor" id="resumo-valor">—</div>
        </div>
        <button class="btn primario bloco" id="btn-pedir" disabled>Chamar motoboy</button>
      </div>
    </div>`;

  // restaura o que já foi preenchido
  $('#in-origem').value = pedido.origem?.titulo || '';
  $('#in-destino').value = pedido.destino?.titulo || '';
  $('#ida-volta').checked = pedido.idaVolta;
  $('#dest-nome').value = pedido.destinatarioNome;
  $('#dest-tel').value = pedido.destinatarioTel;
  $('#obs').value = pedido.observacoes;
  $('#cupom').value = pedido.cupom;
  if (pedido.cupom) $('#bloco-cupom').open = true;
  marcarPonto('origem', pedido.origem, true);
  marcarPonto('destino', pedido.destino, true);
  selecionarOpcoes();
  ativarCampo(pedido.origem && !pedido.destino ? 'destino' : campoAtivo);

  for (const campo of ['origem', 'destino']) {
    const input = $(`#in-${campo}`);
    input.addEventListener('focus', () => {
      ativarCampo(campo);
      input.select();
    });
    input.addEventListener('input', () => buscarEndereco(input.value));
  }
  $('#btn-gps').addEventListener('click', () => usarGps(true));
  $('#sugestoes').addEventListener('mousedown', (e) => e.preventDefault()); // não perde o foco antes do clique
  for (const b of $$('[data-tamanho]')) b.addEventListener('click', () => ((pedido.tamanho = b.dataset.tamanho), selecionarOpcoes(), cotar()));
  for (const b of $$('[data-pagamento]')) b.addEventListener('click', () => ((pedido.pagamento = b.dataset.pagamento), selecionarOpcoes()));
  $('#ida-volta').addEventListener('change', (e) => ((pedido.idaVolta = e.target.checked), cotar()));
  $('#btn-pedir').addEventListener('click', (e) => acao(e.currentTarget, pedir));
  const aplicarCupom = () => {
    pedido.cupom = $('#cupom').value.trim().toUpperCase();
    cotar();
  };
  $('#btn-cupom').addEventListener('click', aplicarCupom);
  $('#cupom').addEventListener('keydown', (e) => e.key === 'Enter' && aplicarCupom());

  if (pedido.origem && pedido.destino) cotar();
  else enquadrar();
}

function selecionarOpcoes() {
  for (const b of $$('[data-tamanho]')) b.classList.toggle('sel', b.dataset.tamanho === pedido.tamanho);
  for (const b of $$('[data-pagamento]')) b.classList.toggle('sel', b.dataset.pagamento === pedido.pagamento);
}

function ativarCampo(campo) {
  campoAtivo = campo;
  for (const l of $$('.end-linha')) l.classList.toggle('ativo', l.dataset.campo === campo);
  const dica = $('#dica');
  if (dica) {
    dica.innerHTML = `Digite o endereço ou <b>toque no mapa</b> para marcar a ${campo === 'origem' ? 'coleta' : 'entrega'}. Dá para arrastar os pinos.`;
  }
}

let timerBusca = null;
let seqBusca = 0;
function buscarEndereco(q) {
  clearTimeout(timerBusca);
  const lista = $('#sugestoes');
  if (q.trim().length < 3) return lista.classList.add('oculto');
  timerBusca = setTimeout(async () => {
    const meu = ++seqBusca;
    const c = pedido.origem || mapa.getCenter(); // prioriza endereços perto da coleta
    try {
      const itens = await api(`/geo/buscar?q=${encodeURIComponent(q)}&lat=${c.lat}&lng=${c.lng}`);
      if (meu !== seqBusca) return;
      lista.innerHTML = itens.length
        ? itens.map((l, i) => `<li tabindex="0" data-i="${i}"><b>${esc(l.titulo)}</b><small>${esc(l.detalhe)}</small></li>`).join('')
        : '<li class="suave">Nenhum endereço encontrado. Tente incluir o número e a cidade, ou toque no mapa.</li>';
      lista.classList.remove('oculto');
      for (const li of $$('li[data-i]', lista)) {
        li.addEventListener('click', () => {
          lista.classList.add('oculto');
          definirPonto(campoAtivo, itens[li.dataset.i]);
          document.activeElement?.blur();
        });
      }
    } catch (e) {
      toast(e.message, 'erro');
    }
  }, 350);
}

function definirPonto(campo, lugar) {
  pedido[campo] = { lat: lugar.lat, lng: lugar.lng, endereco: lugar.endereco, titulo: lugar.titulo };
  const input = $(`#in-${campo}`);
  if (input) input.value = lugar.titulo;
  marcarPonto(campo, pedido[campo], true);
  if (campo === 'origem' && !pedido.destino) ativarCampo('destino');
  if (pedido.origem && pedido.destino) cotar();
  else mapa.setView([lugar.lat, lugar.lng], Math.max(mapa.getZoom(), 15));
}

// Transparência: o cliente sempre vê por que o preço mudou
function mostrarExtrasPreco(r) {
  const linhas = [];
  if (r.adicionalDinamico) {
    linhas.push(
      `<div style="color:var(--marca)">⚡ Alta demanda (${esc(r.motivosDinamica.join(' + '))}): +${brl(r.adicionalDinamico)}` +
        ` <span class="suave">· vai para o motoboy</span></div>`
    );
  }
  if (r.cupom) {
    linhas.push(
      `<div style="color:var(--ok)">🏷️ ${esc(r.cupom.descricao)} (${esc(r.cupom.codigo)}): −${brl(r.desconto)}` +
        `${r.cupom.automatico ? ' <span class="suave">· aplicado automaticamente</span>' : ''}</div>`
    );
  }
  if (r.cupomErro) {
    linhas.push(`<div style="color:var(--perigo)">🏷️ ${esc(r.cupomErro)}</div>`);
    pedido.cupom = ''; // não envia um cupom que não vale
  }
  const el = $('#resumo-extra');
  el.innerHTML = linhas.join('');
  el.style.marginBottom = linhas.length ? '8px' : '0';
}

async function cotar() {
  if (!pedido.origem || !pedido.destino) return;
  $('#opcoes-pedido').classList.remove('oculto');
  $('#dica').classList.add('oculto');
  $('#btn-pedir').disabled = true;
  $('#resumo-info').textContent = 'Calculando…';
  const meu = ++seqCotacao;
  try {
    const r = await api('/cotacao', { metodo: 'POST', corpo: pedido });
    if (meu !== seqCotacao) return;
    cotacao = r;
    $('#resumo-valor').innerHTML = r.desconto
      ? `<small class="suave" style="font-size:.9rem;font-weight:600"><s>${brl(r.precoOriginal)}</s></small> ${brl(r.preco)}`
      : brl(r.preco);
    mostrarExtrasPreco(r);
    $('#resumo-info').textContent = `${km(r.distanciaKm)} · ~${minutos(r.duracaoMin)} de trajeto`;
    $('#resumo-motoboys').innerHTML = r.motoboysProximos
      ? `<span style="color:var(--ok)">● ${r.motoboysProximos} motoboy${r.motoboysProximos > 1 ? 's' : ''} perto da coleta</span>`
      : '<span class="suave">Nenhum motoboy online perto agora</span>';
    $('#btn-pedir').textContent = `Chamar motoboy · ${brl(r.preco)}`;
    $('#btn-pedir').disabled = false;
    desenharRota(r.rota);
    enquadrar();
  } catch (e) {
    if (meu !== seqCotacao) return;
    $('#resumo-valor').textContent = '—';
    $('#resumo-info').textContent = e.message;
  }
}

async function pedir() {
  if ($('#dest-nome')) {
    pedido.destinatarioNome = $('#dest-nome').value;
    pedido.destinatarioTel = $('#dest-tel').value;
    pedido.observacoes = $('#obs').value;
  }
  const c = await api('/corridas', { metodo: 'POST', corpo: pedido });
  mostrarCorrida(c);
}

// pedidoDoUsuario: tocou no 📍 (sempre usa o GPS). Automático ao abrir: só preenche se a coleta ainda estiver vazia,
// porque o GPS pode demorar e não deve apagar um endereço que a pessoa já escolheu.
async function usarGps(pedidoDoUsuario) {
  try {
    const p = await obterGps();
    if (!pedidoDoUsuario && pedido.origem) return;
    mapa.setView([p.lat, p.lng], 16);
    const lugar = await api(`/geo/reverso?lat=${p.lat}&lng=${p.lng}`);
    if (!pedidoDoUsuario && pedido.origem) return;
    if (!corrida) {
      ativarCampo('origem');
      definirPonto('origem', lugar);
    }
  } catch {
    if (pedidoDoUsuario) toast('Não foi possível obter sua localização. Digite o endereço ou toque no mapa.', 'erro');
  }
}

mapa.on('click', async (e) => {
  if (corrida) return; // durante a corrida o mapa só mostra
  const { lat, lng } = e.latlng;
  definirPonto(campoAtivo, await api(`/geo/reverso?lat=${lat}&lng=${lng}`));
});

// ---------- telas da corrida ----------

function mostrarCorrida(c) {
  const mudouStatus = !corrida || corrida.id !== c.id || corrida.status !== c.status;
  corrida = c;
  if (!mudouStatus) return;

  if (c.status === 'procurando') return telaProcurando();
  if (['a_caminho_coleta', 'no_local_coleta', 'em_rota', 'retornando'].includes(c.status)) return telaAtiva();
  if (c.status === 'entregue') return c.minhaAvaliacao ? novoPedido() : telaAvaliar();
  if (c.status === 'expirada') return telaExpirada();
  if (c.status === 'cancelada') {
    toast('Pedido cancelado.');
    return telaPedido();
  }
}

function prepararMapaCorrida() {
  marcarPonto('origem', corrida.origem);
  marcarPonto('destino', corrida.destino);
  desenharRota(corrida.rota);
  if (corrida.motoboy?.posicao) moverMoto(corrida.motoboy.posicao);
  else if (camadas.moto) (camadas.moto.remove(), (camadas.moto = null));
}

function trajetoHtml(c) {
  return `
    <div class="trajeto">
      <div class="linha"><span class="ponto origem"></span><div class="cresce"><small class="suave">Coleta</small><div>${esc(c.origem.endereco)}</div></div></div>
      <div class="linha"><span class="ponto destino"></span><div class="cresce"><small class="suave">Entrega</small><div>${esc(c.destino.endereco)}</div></div></div>
    </div>`;
}

const precoHtml = (c) =>
  c.desconto
    ? `<span><small class="suave"><s>${brl(c.precoOriginal)}</s> 🏷️ ${esc(c.cupom || '')}</small> <b>${brl(c.preco)}</b></span>`
    : `<b>${brl(c.preco)}</b>`;

function telaProcurando() {
  prepararMapaCorrida();
  painel.innerHTML = `
    <div class="radar"><span></span><span></span><span></span><i>🛵</i></div>
    <h2 class="centro">Procurando motoboy…</h2>
    <p class="centro suave">Chamando os motoboys mais próximos da coleta. Isso costuma levar menos de 1 minuto.</p>
    <div class="cartao">${trajetoHtml(corrida)}
      <div class="linha entre"><span class="suave">${PAGAMENTO_TEXTO[corrida.pagamento]}</span>${precoHtml(corrida)}</div>
    </div>
    <button class="btn perigo bloco" id="btn-cancelar">Cancelar pedido</button>`;
  $('#btn-cancelar').addEventListener('click', (e) => cancelar(e.currentTarget));
  enquadrar();
}

function linkRastreio() {
  // no app, location.origin é o próprio celular: o link precisa apontar para o servidor
  return `${MOTOX.servidor || location.origin}/rastreio.html?c=${corrida.codigoRastreio}`;
}

function textoParaDestinatario() {
  return (
    `Olá! Estou te enviando uma entrega pelo MotoX 🛵\n` +
    `Acompanhe ao vivo: ${linkRastreio()}\n` +
    `Código de entrega: *${corrida.pin}* — informe ao motoboy só quando receber o pacote.`
  );
}

function telaAtiva() {
  prepararMapaCorrida();
  const c = corrida;
  const m = c.motoboy;
  const telWhats = c.destinatario?.telefone ? `55${c.destinatario.telefone}` : '';
  const podeCancelar = ['a_caminho_coleta', 'no_local_coleta'].includes(c.status);
  painel.innerHTML = `
    <h2 style="margin-bottom:2px">${esc(STATUS[c.status].texto)}</h2>
    <p class="suave" id="eta" style="margin:0 0 6px"></p>
    <div class="cartao motoboy-card">
      <div class="avatar">${esc(iniciais(m.nome))}</div>
      <div class="cresce">
        <b>${esc(m.nome)}</b>
        <div class="suave peq">${esc(m.moto || '')} · ${notaTexto(m.nota)}</div>
        <span class="placa">${esc(m.placa || '')}</span>
      </div>
      <a class="btn-icone" href="tel:${esc(m.telefone)}" aria-label="Ligar">📞</a>
      <a class="btn-icone" href="https://wa.me/55${esc(m.telefone)}" target="_blank" rel="noopener" aria-label="WhatsApp">💬</a>
    </div>
    ${
      c.status === 'retornando'
        ? ''
        : `<div class="cartao">
            <div class="suave peq centro">Código de entrega</div>
            <div class="pin">${esc(c.pin)}</div>
            <div class="suave peq centro">O motoboy só finaliza com este código. Passe para quem vai receber.</div>
          </div>
          <div class="linha">
            <a class="btn contorno cresce peq" target="_blank" rel="noopener"
               href="https://wa.me/${telWhats}?text=${encodeURIComponent(textoParaDestinatario())}">💬 WhatsApp</a>
            <button class="btn contorno cresce peq" id="btn-compartilhar">🔗 Rastreio</button>
          </div>`
    }
    ${etapasHtml(c)}
    <div class="cartao">${trajetoHtml(c)}
      <div class="linha entre"><span class="suave">${PAGAMENTO_TEXTO[c.pagamento]}${c.idaVolta ? ' · ida e volta' : ''}</span>${precoHtml(c)}</div>
    </div>
    ${podeCancelar ? '<button class="btn perigo bloco" id="btn-cancelar">Cancelar pedido</button>' : ''}`;

  $('#btn-cancelar')?.addEventListener('click', (e) => cancelar(e.currentTarget));
  $('#btn-compartilhar')?.addEventListener('click', compartilhar);
  atualizarEta(m.posicao);
  enquadrar();
}

function atualizarEta(pos) {
  const el = $('#eta');
  if (!el || !corrida || !pos) return;
  const alvo = { a_caminho_coleta: corrida.origem, em_rota: corrida.destino, retornando: corrida.origem }[corrida.status];
  if (corrida.status === 'no_local_coleta') el.textContent = 'O motoboy está retirando o pacote.';
  else if (alvo) el.textContent = `Chegada estimada em ~${etaMin(pos, alvo)} min`;
}

async function compartilhar() {
  const dados = { title: 'Rastreio MotoX', text: textoParaDestinatario(), url: linkRastreio() };
  try {
    if (navigator.share) return await navigator.share(dados);
    await navigator.clipboard.writeText(linkRastreio());
    toast('Link de rastreio copiado!', 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') prompt('Copie o link de rastreio:', linkRastreio());
  }
}

async function cancelar(botao) {
  if (!confirm('Cancelar este pedido?')) return;
  await acao(botao, async () => {
    const r = await api(`/corridas/${corrida.id}/cancelar`, { metodo: 'POST' });
    if (corrida && corrida.id === r.id) mostrarCorrida(r); // o socket pode ter chegado antes
  });
}

function telaAvaliar() {
  prepararMapaCorrida();
  if (camadas.moto) (camadas.moto.remove(), (camadas.moto = null));
  let nota = 0;
  painel.innerHTML = `
    <div class="centro">
      <div style="font-size:3rem">✅</div>
      <h2>Entrega concluída!</h2>
      <p class="suave">Entregue às ${hora(corrida.entregueEm)} por ${esc(corrida.motoboy.nome.split(' ')[0])}.</p>
      <p>Como foi o motoboy?</p>
    </div>
    <div class="estrelas">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" aria-label="${n} estrelas">★</button>`).join('')}</div>
    <button class="btn primario bloco" id="btn-avaliar" disabled>Enviar avaliação</button>
    <button class="btn contorno bloco" id="btn-pular" style="margin-top:8px">Agora não</button>`;
  for (const b of $$('.estrelas button')) {
    b.addEventListener('click', () => {
      nota = Number(b.dataset.n);
      for (const x of $$('.estrelas button')) x.classList.toggle('on', Number(x.dataset.n) <= nota);
      $('#btn-avaliar').disabled = false;
    });
  }
  $('#btn-avaliar').addEventListener('click', (e) =>
    acao(e.currentTarget, async () => {
      await api(`/corridas/${corrida.id}/avaliar`, { metodo: 'POST', corpo: { nota } });
      toast('Obrigado pela avaliação!', 'ok');
      novoPedido();
    })
  );
  $('#btn-pular').addEventListener('click', novoPedido);
  enquadrar();
}

function telaExpirada() {
  prepararMapaCorrida();
  painel.innerHTML = `
    <div class="centro"><div style="font-size:3rem">😕</div>
      <h2>Nenhum motoboy disponível</h2>
      <p class="suave">Todos os motoboys próximos estão ocupados agora. Você não foi cobrado.</p>
    </div>
    <button class="btn primario bloco" id="btn-tentar">Tentar novamente</button>
    <button class="btn contorno bloco" id="btn-voltar" style="margin-top:8px">Alterar pedido</button>`;
  $('#btn-tentar').addEventListener('click', (e) => acao(e.currentTarget, pedir));
  $('#btn-voltar').addEventListener('click', telaPedido);
}

// Depois de uma entrega, mantém a coleta (quem envia costuma enviar do mesmo lugar)
function novoPedido() {
  Object.assign(pedido, { destino: null, observacoes: '', destinatarioNome: '', destinatarioTel: '', idaVolta: false, cupom: '' });
  cotacao = null;
  telaPedido();
}

// ---------- histórico ----------

$('#btn-historico').addEventListener('click', async () => {
  const lista = $('#lista-historico');
  lista.innerHTML = '<li class="suave">Carregando…</li>';
  $('#modal-historico').classList.remove('oculto');
  try {
    const itens = await api('/corridas');
    lista.innerHTML = itens.length
      ? itens
          .map(
            (c) => `<li>
              <div class="linha entre"><small class="suave">${dataHora(c.criadoEm)}</small>${seloStatus(c.status)}</div>
              <div class="trunca">➜ ${esc(c.destino.endereco)}</div>
              <div class="linha entre peq"><span class="suave">${c.motoboy ? esc(c.motoboy.nome) : '—'}</span><b>${brl(c.preco)}</b></div>
            </li>`
          )
          .join('')
      : '<li class="suave">Você ainda não fez nenhuma entrega.</li>';
  } catch (e) {
    lista.innerHTML = `<li class="suave">${esc(e.message)}</li>`;
  }
});
$('[data-fechar]').addEventListener('click', () => $('#modal-historico').classList.add('oculto'));
$('#btn-sair').addEventListener('click', () => confirm('Sair da sua conta?') && Sessao.sair());

// ---------- tempo real ----------

const ATIVOS = ['procurando', 'a_caminho_coleta', 'no_local_coleta', 'em_rota', 'retornando'];

sock.on('corrida', (c) => {
  // sem corrida na tela, só uma corrida ativa nova (ex.: pedida em outra aba) deve aparecer
  if (corrida ? c.id >= corrida.id : ATIVOS.includes(c.status)) mostrarCorrida(c);
});
sock.on('local', (d) => {
  if (corrida && d.corridaId === corrida.id) {
    corrida.motoboy && (corrida.motoboy.posicao = { lat: d.lat, lng: d.lng });
    moverMoto(d);
  }
});
sock.io.on('reconnect', sincronizar);

async function sincronizar() {
  const { corrida: c } = await api('/corridas/ativa');
  if (c) {
    corrida = null; // força redesenhar
    mostrarCorrida(c);
  } else if (corrida && ATIVOS.includes(corrida.status)) {
    mostrarCorrida(await api(`/corridas/${corrida.id}`));
  }
}

(async () => {
  try {
    config = await api('/config');
    const { corrida: c } = await api('/corridas/ativa');
    if (c) return mostrarCorrida(c);
    telaPedido();
    usarGps(false);
  } catch (e) {
    toast(e.message, 'erro');
  }
})();
