const usuario = exigirLogin('motoboy');
const mapa = criarMapa('mapa');
const painel = $('#painel');
const sock = conectarSocket();

let online = false;
let pos = null;
let temGps = false;
let simulando = null;
let corrida = null;
let oferta = null;
let resumo = null;
const camadas = { eu: null, origem: null, destino: null, rota: null };

// ---------- localização ----------

function definirPos(p, { centralizar = false } = {}) {
  pos = { lat: p.lat, lng: p.lng };
  if (!camadas.eu) camadas.eu = L.marker([pos.lat, pos.lng], { icon: ICONES.eu(), zIndexOffset: 1000 }).addTo(mapa);
  else camadas.eu.setLatLng([pos.lat, pos.lng]);
  if (centralizar) mapa.setView([pos.lat, pos.lng], 16);
  if (online || corrida) sock.emit('motoboy:local', pos);
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (p) => {
      const primeira = !temGps;
      temGps = true;
      if (!simulando) definirPos({ lat: p.coords.latitude, lng: p.coords.longitude }, { centralizar: primeira && !corrida });
      if (primeira && !corrida) renderizar();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

// No app: GPS contínuo (segue com a tela apagada) enquanto estiver online ou em corrida.
// Ligar só nesses momentos economiza bateria e evita a notificação fixa à toa.
let gpsContinuo = null;
let gpsAlterando = false;
async function sincronizarGpsContinuo() {
  if (!Nativo.ativo || gpsAlterando) return;
  const precisa = online || !!corrida;
  if (precisa === !!gpsContinuo) return;
  gpsAlterando = true;
  try {
    if (precisa) {
      gpsContinuo = await Nativo.iniciarGpsContinuo((p) => {
        temGps = true;
        if (!simulando) definirPos(p);
      });
    } else {
      await Nativo.pararGpsContinuo(gpsContinuo);
      gpsContinuo = null;
    }
  } finally {
    gpsAlterando = false;
  }
  sincronizarGpsContinuo(); // o estado pode ter mudado enquanto ligava/desligava
}

// Sem GPS (ex.: celular acessando por http na rede local), o motoboy marca a posição tocando no mapa
mapa.on('click', (e) => {
  if (temGps && !simulando) return;
  definirPos(e.latlng);
  if (!corrida) renderizar();
});

// Modo teste: anda sozinho até o próximo ponto da corrida
function alternarSimulacao() {
  if (simulando) {
    clearInterval(simulando);
    simulando = null;
    return renderizar();
  }
  const alvo = alvoAtual();
  if (!alvo || !pos) return toast('Marque sua posição no mapa primeiro.', 'erro');
  simulando = setInterval(() => {
    const a = alvoAtual();
    if (!a) return alternarSimulacao();
    const d = distanciaKm(pos, a);
    if (d < 0.03) {
      definirPos(a);
      clearInterval(simulando);
      simulando = null;
      toast('Você chegou ao destino (simulação).', 'ok');
      return renderizar();
    }
    const k = Math.min(1, Math.max(0.05, 0.12 / d)); // ~120 m por passo
    definirPos({ lat: pos.lat + (a.lat - pos.lat) * k, lng: pos.lng + (a.lng - pos.lng) * k });
  }, 1000);
  renderizar();
}

function alvoAtual() {
  if (!corrida) return null;
  if (['a_caminho_coleta', 'retornando'].includes(corrida.status)) return corrida.origem;
  if (corrida.status === 'em_rota') return corrida.destino;
  return null;
}

// ---------- online / offline ----------

function atualizarTopo() {
  $('#ponto-status').style.background = online ? 'var(--ok)' : 'var(--suave)';
  $('#texto-status').textContent = corrida
    ? 'Em corrida'
    : usuario.statusCadastro !== 'aprovado'
      ? 'Em análise'
      : online
        ? 'Online'
        : 'Offline';
  if (resumo) $('#ganho-hoje').textContent = brl(resumo.hoje.total);
}

function ficarOnline(valor, botao) {
  if (valor && !pos) return toast('Marque onde você está: toque no mapa ou ative o GPS.', 'erro');
  if (botao) botao.disabled = true;
  sock.emit('motoboy:status', { online: valor, ...(pos || {}) }, (r) => {
    if (botao) botao.disabled = false;
    if (r && r.erro) return toast(r.erro, 'erro');
    online = valor;
    if (valor) Nativo.prepararNotificacoes(); // pede permissão num momento que faz sentido
    renderizar();
  });
}

async function carregarResumo() {
  try {
    resumo = await api('/motoboy/resumo');
    atualizarTopo();
  } catch {}
}

// ---------- mapa da corrida ----------

function desenharCorrida(c) {
  for (const k of ['origem', 'destino', 'rota']) {
    if (camadas[k]) camadas[k].remove();
    camadas[k] = null;
  }
  if (!c) return;
  camadas.origem = L.marker([c.origem.lat, c.origem.lng], { icon: ICONES.origem() }).addTo(mapa);
  camadas.destino = L.marker([c.destino.lat, c.destino.lng], { icon: ICONES.destino() }).addTo(mapa);
  if (c.rota) camadas.rota = L.polyline(c.rota, { color: '#141414', weight: 5, opacity: 0.8 }).addTo(mapa);
  const pontos = [camadas.origem.getLatLng(), camadas.destino.getLatLng()];
  if (pos) pontos.push(L.latLng(pos.lat, pos.lng));
  const desktop = innerWidth >= 900;
  mapa.fitBounds(L.latLngBounds(pontos), {
    paddingTopLeft: desktop ? [440, 40] : [30, 80],
    paddingBottomRight: desktop ? [40, 40] : [30, innerHeight * 0.55],
    maxZoom: 16,
  });
}

// ---------- oferta ----------

let animOferta = null;
let audio = null;

function alertaSonoro() {
  try {
    navigator.vibrate?.([300, 150, 300, 150, 300]);
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + t);
      o.stop(audio.currentTime + t + 0.2);
    });
  } catch {}
}

function mostrarOferta(o) {
  oferta = o;
  const c = o.corrida;
  const fim = performance.now() + o.tempoRestanteMs;
  const valorKm = c.ganhoMotoboy / (c.distanciaKm + o.distanciaAteColetaKm || 1);
  $('#oferta').innerHTML = `
    <div class="linha entre"><span class="selo alerta">Nova corrida</span><b id="oferta-seg"></b></div>
    <div class="barra-tempo"><div id="oferta-barra"></div></div>
    <div class="linha entre" style="align-items:flex-end">
      <div><div class="suave peq">Você recebe</div><div class="ganho">${brl(c.ganhoMotoboy)}</div></div>
      <div style="text-align:right" class="peq suave">${brl(valorKm)}/km<br>cliente paga ${brl(c.preco)}${c.desconto ? ' (com cupom)' : ''}<br>taxa MotoX ${brl(Math.max(0, c.taxaPlataforma))}</div>
    </div>
    <div class="trajeto">
      <div class="linha"><span class="ponto origem"></span><div class="cresce"><small class="suave">Coleta · a ${km(o.distanciaAteColetaKm)} de você</small><div>${esc(c.origem.endereco)}</div></div></div>
      <div class="linha"><span class="ponto destino"></span><div class="cresce"><small class="suave">Entrega · ${km(c.distanciaKm)} de percurso</small><div>${esc(c.destino.endereco)}</div></div></div>
    </div>
    <div class="linha" style="flex-wrap:wrap;gap:6px;margin-bottom:14px">
      <span class="selo">${TAMANHO_TEXTO[c.tamanho]}</span>
      <span class="selo">${PAGAMENTO_TEXTO[c.pagamento]}</span>
      ${c.idaVolta ? '<span class="selo info">Ida e volta</span>' : ''}
      ${c.adicionalDinamico ? `<span class="selo alerta">⚡ inclui +${brl(c.adicionalDinamico)} (${esc(c.motivoDinamico || 'alta demanda')})</span>` : ''}
      ${c.cliente.nota ? `<span class="selo">Cliente ${notaTexto(c.cliente.nota)}</span>` : ''}
    </div>
    <div class="linha">
      <button class="btn contorno" id="btn-recusar">Recusar</button>
      <button class="btn ok cresce" id="btn-aceitar">Aceitar</button>
    </div>`;
  $('#modal-oferta').classList.remove('oculto');
  desenharCorrida(c);
  alertaSonoro();
  Nativo.notificar(`Nova corrida · ${brl(c.ganhoMotoboy)}`, `Coleta a ${km(o.distanciaAteColetaKm)}: ${c.origem.endereco}`);

  cancelAnimationFrame(animOferta);
  const passo = () => {
    const resta = Math.max(0, fim - performance.now());
    const barra = $('#oferta-barra');
    if (!barra) return;
    barra.style.transform = `scaleX(${resta / o.tempoTotalMs})`;
    $('#oferta-seg').textContent = `${Math.ceil(resta / 1000)}s`;
    if (resta > 0) animOferta = requestAnimationFrame(passo);
  };
  passo();

  $('#btn-aceitar').addEventListener('click', (e) =>
    acao(e.currentTarget, async () => {
      const r = await api(`/corridas/${c.id}/aceitar`, { metodo: 'POST' });
      fecharOferta();
      mostrarCorrida(r);
    })
  );
  $('#btn-recusar').addEventListener('click', async () => {
    fecharOferta();
    try {
      await api(`/corridas/${c.id}/recusar`, { metodo: 'POST' });
    } catch {}
    renderizar();
  });
}

function fecharOferta(corridaId, motivo) {
  if (corridaId && (!oferta || oferta.corrida.id !== corridaId)) return;
  cancelAnimationFrame(animOferta);
  oferta = null;
  $('#modal-oferta').classList.add('oculto');
  if (motivo) toast(motivo);
  if (!corrida) {
    desenharCorrida(null);
    renderizar();
  }
}

// ---------- telas ----------

function mostrarCorrida(c) {
  const mudou = !corrida || corrida.id !== c.id || corrida.status !== c.status;
  corrida = c;
  if (!mudou) return;
  if (simulando) alternarSimulacao();
  desenharCorrida(['entregue', 'cancelada', 'procurando'].includes(c.status) ? null : c);
  if (c.status === 'entregue') carregarResumo();
  if (c.status === 'cancelada') {
    toast('O cliente cancelou a corrida.', 'erro');
    corrida = null;
  }
  if (c.status === 'procurando') corrida = null; // desistiu: a corrida voltou para a fila
  renderizar();
}

function renderizar() {
  atualizarTopo();
  sincronizarGpsContinuo();
  if (!corrida) return telaEspera();
  const c = corrida;
  if (c.status === 'entregue') return telaConcluida();

  const etapa = {
    a_caminho_coleta: {
      titulo: 'Vá até a coleta',
      alvo: c.origem,
      botao: 'Cheguei na coleta',
      acao: 'chegou',
    },
    no_local_coleta: { titulo: 'Retire o pacote', alvo: c.origem, botao: 'Pacote coletado', acao: 'coletar' },
    em_rota: { titulo: 'Leve até a entrega', alvo: c.destino },
    retornando: { titulo: 'Volte à coleta', alvo: c.origem, botao: 'Cheguei · concluir corrida', acao: 'finalizar' },
  }[c.status];
  const nav = linkNavegacao(etapa.alvo);
  const naColeta = ['a_caminho_coleta', 'no_local_coleta', 'retornando'].includes(c.status);
  const contato = naColeta ? c.cliente : { nome: c.destinatario.nome || 'Destinatário', telefone: c.destinatario.telefone };
  const pagarDinheiro = c.pagamento === 'dinheiro' && naColeta && c.status !== 'retornando';

  painel.innerHTML = `
    ${seloStatus(c.status)}
    <h2>${etapa.titulo}</h2>
    <div class="cartao">
      <div class="linha"><span class="ponto ${naColeta ? 'origem' : 'destino'}"></span><div class="cresce">${esc(etapa.alvo.endereco)}</div></div>
      <div class="linha" style="margin-top:10px">
        <a class="btn contorno peq cresce" href="${nav.google}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        <a class="btn contorno peq cresce" href="${nav.waze}" target="_blank" rel="noopener">🚀 Waze</a>
      </div>
    </div>
    ${
      contato.telefone
        ? `<div class="cartao linha">
            <div class="avatar" style="width:42px;height:42px;font-size:1rem">${esc(iniciais(contato.nome))}</div>
            <div class="cresce"><b>${esc(contato.nome)}</b><div class="suave peq">${naColeta ? 'Cliente' : 'Quem recebe'} · ${formatarTel(contato.telefone)}</div></div>
            <a class="btn-icone" href="tel:${esc(contato.telefone)}" aria-label="Ligar">📞</a>
            <a class="btn-icone" href="https://wa.me/55${esc(contato.telefone)}" target="_blank" rel="noopener" aria-label="WhatsApp">💬</a>
          </div>`
        : ''
    }
    ${c.observacoes ? `<div class="cartao"><small class="suave">Observações</small><div>${esc(c.observacoes)}</div></div>` : ''}
    ${pagarDinheiro ? `<div class="cartao" style="border:1px solid var(--marca)">💵 Receber <b>${brl(c.preco)}</b> em dinheiro do cliente na coleta.</div>` : ''}
    ${
      c.status === 'em_rota'
        ? `<label class="campo"><span>Código de entrega (peça a quem recebe)</span>
             <input class="input" id="pin" inputmode="numeric" maxlength="4" pattern="[0-9]*" autocomplete="one-time-code"
               placeholder="0000" style="font-size:1.6rem;letter-spacing:10px;text-align:center"></label>
           <button class="btn primario bloco" id="btn-entregar">Finalizar entrega</button>`
        : `<button class="btn primario bloco" id="btn-etapa">${etapa.botao}</button>`
    }
    <div class="linha entre peq" style="margin-top:14px">
      <span class="suave">Ganho desta corrida</span><b style="color:var(--marca)">${brl(c.ganhoMotoboy)}</b>
    </div>
    <div class="linha" style="margin-top:12px;flex-wrap:wrap">
      <button class="btn contorno peq" id="btn-simular">${simulando ? '⏸ Parar simulação' : '🧪 Simular trajeto'}</button>
      ${['a_caminho_coleta', 'no_local_coleta'].includes(c.status) ? '<button class="btn perigo peq" id="btn-desistir">Desistir</button>' : ''}
    </div>`;

  $('#btn-etapa')?.addEventListener('click', (e) =>
    acao(e.currentTarget, async () => mostrarCorrida(await api(`/corridas/${c.id}/${etapa.acao}`, { metodo: 'POST' })))
  );
  $('#btn-entregar')?.addEventListener('click', (e) => {
    const pin = $('#pin').value.trim();
    if (!/^\d{4}$/.test(pin)) return toast('Digite o código de 4 dígitos.', 'erro');
    acao(e.currentTarget, async () => mostrarCorrida(await api(`/corridas/${c.id}/entregar`, { metodo: 'POST', corpo: { pin } })));
  });
  $('#btn-simular').addEventListener('click', alternarSimulacao);
  $('#btn-desistir')?.addEventListener('click', (e) => {
    if (!confirm('Desistir desta corrida? Ela será oferecida a outro motoboy.')) return;
    acao(e.currentTarget, async () => {
      await api(`/corridas/${c.id}/desistir`, { metodo: 'POST' });
      corrida = null;
      desenharCorrida(null);
      renderizar();
    });
  });
}

// ---------- cadastro em análise / reprovado ----------

function guardarUsuario(mudancas) {
  Object.assign(usuario, mudancas);
  try {
    localStorage.setItem('motox_usuario', JSON.stringify(usuario));
  } catch {}
}

const NOME_DOC = { cnh: 'Carteira de motorista (CNH)', crlv: 'Documento da moto (CRLV)' };

async function telaCadastro() {
  if (usuario.statusCadastro === 'reprovado') {
    const reenvio = {};
    painel.innerHTML = `
      <div class="centro"><div style="font-size:2.6rem">⚠️</div><h2>Cadastro não aprovado</h2></div>
      <div class="cartao" style="border:1px solid var(--perigo)">
        <small class="suave">Motivo informado pela equipe MotoX</small>
        <div>${esc(usuario.motivoReprovacao || 'Documentos com problema.')}</div>
      </div>
      <p class="suave peq">Corrija e envie de novo. Pode reenviar só o documento que foi pedido; o outro continua valendo.</p>
      <div id="docs-reenvio">${campoDocumento('cnh')}${campoDocumento('crlv')}</div>
      <button class="btn primario bloco" id="btn-reenviar">Enviar para nova análise</button>`;
    ativarCamposDocumento($('#docs-reenvio'), reenvio);
    $('#btn-reenviar').addEventListener('click', (e) => {
      if (!Object.keys(reenvio).length) return toast('Anexe pelo menos um documento corrigido.', 'erro');
      acao(e.currentTarget, async () => {
        const r = await api('/motoboy/documentos', { metodo: 'POST', corpo: { documentos: reenvio } });
        guardarUsuario({ statusCadastro: r.statusCadastro, motivoReprovacao: null });
        toast('Documentos enviados! Agora é só aguardar a análise.', 'ok');
        renderizar();
      });
    });
    return;
  }

  painel.innerHTML = `
    <div class="centro">
      <div style="font-size:2.6rem">⏳</div>
      <h2>Cadastro em análise</h2>
      <p class="suave">A equipe MotoX está conferindo sua CNH e o documento da moto.
        Assim que for aprovado, você recebe o aviso aqui e já pode ficar online. Costuma levar até 24h.</p>
    </div>
    <div class="cartao" id="docs-enviados"><small class="suave">Carregando documentos…</small></div>`;
  try {
    const r = await api('/motoboy/documentos');
    // conta criada antes da exigência de documentos (ou envio incompleto): pede o que falta
    const faltando = ['cnh', 'crlv'].filter((t) => !r.documentos.some((d) => d.tipo === t));
    if (faltando.length) return telaEnviarFaltantes(faltando);
    $('#docs-enviados').innerHTML = r.documentos.length
      ? r.documentos
          .map((d) => `<div class="linha" style="padding:4px 0">✅ <span class="cresce">${NOME_DOC[d.tipo]}</span><small class="suave">${dataHora(d.enviadoEm)}</small></div>`)
          .join('')
      : '<small class="suave">Nenhum documento recebido.</small>';
  } catch {}
}

function telaEnviarFaltantes(faltando) {
  const envio = {};
  painel.innerHTML = `
    <div class="centro"><div style="font-size:2.6rem">📎</div><h2>Envie seus documentos</h2>
      <p class="suave">Para ficar online, a MotoX precisa conferir sua carteira de motorista e o documento da moto.</p></div>
    <div id="docs-faltantes">${faltando.map(campoDocumento).join('')}</div>
    <p class="suave peq">🔒 Usados só para verificar seu cadastro e vistos apenas pela equipe MotoX.</p>
    <button class="btn primario bloco" id="btn-enviar-docs">Enviar para análise</button>`;
  ativarCamposDocumento($('#docs-faltantes'), envio);
  $('#btn-enviar-docs').addEventListener('click', (e) => {
    const ainda = faltando.filter((t) => !envio[t]);
    if (ainda.length) return toast(`Anexe ${ainda.map((t) => (t === 'cnh' ? 'a CNH' : 'o documento da moto')).join(' e ')}.`, 'erro');
    acao(e.currentTarget, async () => {
      await api('/motoboy/documentos', { metodo: 'POST', corpo: { documentos: envio } });
      toast('Documentos enviados! Agora é só aguardar a análise.', 'ok');
      renderizar();
    });
  });
}

function telaEspera() {
  if (usuario.statusCadastro !== 'aprovado') return telaCadastro();
  const semPosicao = !pos;
  painel.innerHTML = online
    ? `<div class="radar"><span></span><span></span><span></span><i>🛵</i></div>
       <h2 class="centro">Procurando corridas…</h2>
       <p class="centro suave">Fique com o app aberto. Cada oferta fica disponível por alguns segundos.</p>`
    : `<h2>Você está offline</h2>
       <p class="suave">Fique online para começar a receber corridas perto de você.</p>`;
  painel.innerHTML += `
    ${
      semPosicao || !temGps
        ? `<p class="dica-mapa">${semPosicao ? '📍 <b>Toque no mapa</b> para marcar onde você está' : 'Sem GPS: toque no mapa para atualizar sua posição'} (no celular o GPS exige HTTPS).</p>`
        : ''
    }
    <button class="btn ${online ? 'contorno' : 'primario'} bloco" id="btn-online" style="margin-top:10px">
      ${online ? 'Ficar offline' : 'Ficar online'}
    </button>
    <div class="opcoes" style="margin-top:16px">
      <div class="opcao"><small>Hoje</small><b>${brl(resumo?.hoje.total)}</b><small>${resumo?.hoje.qtd ?? 0} corridas</small></div>
      <div class="opcao"><small>Semana</small><b>${brl(resumo?.semana.total)}</b><small>${resumo?.semana.qtd ?? 0} corridas</small></div>
      <div class="opcao"><small>Sua nota</small><b>${notaTexto(resumo?.nota ?? null)}</b><small>${esc(usuario.placa || '')}</small></div>
    </div>`;
  $('#btn-online').addEventListener('click', (e) => ficarOnline(!online, e.currentTarget));
}

// Em dinheiro o motoboy fica com o valor pago pelo cliente; o acerto com a plataforma vai no repasse.
// Com cupom, a plataforma paga o desconto: pode ser ela quem deve ao motoboy.
function avisoDinheiro(c) {
  const t = c.taxaPlataforma;
  const texto = t >= 0
    ? `Você recebeu ${brl(c.preco)} em dinheiro; a taxa de ${brl(t)} será descontada no repasse.`
    : `Você recebeu ${brl(c.preco)} em dinheiro (com cupom); a MotoX vai te repassar mais ${brl(-t)}.`;
  return `<p class="suave peq">${texto}</p>`;
}

function telaConcluida() {
  const c = corrida;
  let nota = 0;
  painel.innerHTML = `
    <div class="centro">
      <div style="font-size:3rem">🎉</div>
      <h2>Corrida concluída!</h2>
      <div class="ganho" style="font-size:2.4rem;font-weight:900;color:var(--marca)">+ ${brl(c.ganhoMotoboy)}</div>
      ${c.pagamento === 'dinheiro' ? avisoDinheiro(c) : ''}
      <p>Como foi o cliente ${esc(c.cliente.nome.split(' ')[0])}?</p>
    </div>
    <div class="estrelas">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" aria-label="${n} estrelas">★</button>`).join('')}</div>
    <button class="btn primario bloco" id="btn-continuar">Continuar</button>`;
  for (const b of $$('.estrelas button')) {
    b.addEventListener('click', () => {
      nota = Number(b.dataset.n);
      for (const x of $$('.estrelas button')) x.classList.toggle('on', Number(x.dataset.n) <= nota);
    });
  }
  $('#btn-continuar').addEventListener('click', async (e) => {
    if (nota && !c.minhaAvaliacao) {
      await acao(e.currentTarget, () => api(`/corridas/${c.id}/avaliar`, { metodo: 'POST', corpo: { nota } }));
    }
    corrida = null;
    desenharCorrida(null);
    if (pos) mapa.setView([pos.lat, pos.lng], 15);
    renderizar();
  });
}

// ---------- tempo real ----------

sock.on('oferta', mostrarOferta);
sock.on('oferta:expirada', (d) => fecharOferta(d.corridaId, 'A oferta expirou e foi para outro motoboy.'));
sock.on('oferta:cancelada', (d) => fecharOferta(d.corridaId, 'O cliente cancelou o pedido.'));
sock.on('corrida', (c) => {
  if (corrida && c.id === corrida.id) mostrarCorrida(c);
});
// resultado da análise chega na hora, sem precisar recarregar
sock.on('conta:cadastro', (d) => {
  guardarUsuario(d);
  if (d.statusCadastro === 'aprovado') {
    toast('🎉 Cadastro aprovado! Fique online para começar a receber corridas.', 'ok');
    alertaSonoro();
  } else if (d.statusCadastro === 'reprovado') {
    toast('Seu cadastro precisa de correção. Veja o motivo.', 'erro');
    online = false;
  }
  if (!corrida) renderizar();
});

sock.on('connect', async () => {
  // reconexão: o servidor esquece quem estava online quando o socket cai
  if (online && pos) sock.emit('motoboy:status', { online: true, ...pos }, () => {});
  try {
    const r = await api('/corridas/ativa');
    if (r.corrida) mostrarCorrida(r.corrida);
    if (r.oferta && !oferta) mostrarOferta(r.oferta);
  } catch {}
});

$('#btn-sair').addEventListener('click', () => {
  if (corrida) return toast('Finalize a corrida antes de sair.', 'erro');
  if (confirm('Sair da sua conta?')) Sessao.sair();
});

// O navegador só libera som depois de um toque do usuário
document.addEventListener('pointerdown', () => {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {}
}, { once: true });

renderizar();
carregarResumo();
// a situação do cadastro pode ter mudado desde o login (ex.: aprovado enquanto o app estava fechado)
api('/eu')
  .then((u) => {
    const mudou = u.statusCadastro !== usuario.statusCadastro;
    guardarUsuario({ statusCadastro: u.statusCadastro, motivoReprovacao: u.motivoReprovacao });
    if (mudou && !corrida) renderizar();
  })
  .catch(() => {});
