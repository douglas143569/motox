// Recursos do celular quando a página roda dentro do app (Capacitor).
// No navegador tudo aqui vira "não faz nada", e as telas usam as APIs web normais.

const Nativo = (() => {
  const cap = window.Capacitor;
  const ativo = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const plugin = (nome) => (ativo ? cap.registerPlugin(nome) : null);

  const Gps = plugin('BackgroundGeolocation');
  const Notificacoes = plugin('LocalNotifications');
  const App = plugin('App');

  let emSegundoPlano = false;
  if (App) App.addListener('appStateChange', ({ isActive }) => (emSegundoPlano = !isActive));

  let canalCriado = false;
  async function prepararNotificacoes() {
    if (!Notificacoes || canalCriado) return;
    try {
      const { display } = await Notificacoes.requestPermissions();
      if (display !== 'granted') return;
      // Android: canal de prioridade máxima para tocar e aparecer por cima, como app de motorista
      await Notificacoes.createChannel({
        id: 'ofertas',
        name: 'Ofertas de corrida',
        description: 'Avisa quando uma nova corrida é oferecida',
        importance: 5,
        visibility: 1,
        vibration: true,
      });
      canalCriado = true;
    } catch {}
  }

  return {
    ativo,
    get emSegundoPlano() {
      return emSegundoPlano;
    },
    prepararNotificacoes,

    // Só notifica se o app não estiver na tela (na tela, o modal da oferta já aparece)
    async notificar(titulo, corpo) {
      if (!Notificacoes || !emSegundoPlano) return;
      await prepararNotificacoes();
      try {
        await Notificacoes.schedule({
          notifications: [{ id: Date.now() % 2147483647, title: titulo, body: corpo, channelId: 'ofertas' }],
        });
      } catch {}
    },

    // GPS que continua funcionando com a tela apagada ou com outro app aberto (Waze, Maps).
    // No Android mostra a notificação fixa "Você está online", exigida pelo sistema.
    async iniciarGpsContinuo(aoMover) {
      if (!Gps) return null;
      return Gps.addWatcher(
        {
          backgroundTitle: 'MotoX Entregador',
          backgroundMessage: 'Você está online e recebendo corridas.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 15,
        },
        (local, erro) => {
          if (erro) {
            if (erro.code === 'NOT_AUTHORIZED' && confirm('O MotoX precisa da sua localização para enviar corridas. Abrir as configurações?')) {
              Gps.openSettings();
            }
            return;
          }
          if (local) aoMover({ lat: local.latitude, lng: local.longitude });
        }
      );
    },

    async pararGpsContinuo(id) {
      if (Gps && id) await Gps.removeWatcher({ id });
    },
  };
})();
