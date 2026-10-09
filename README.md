# MotoX 🛵

Plataforma para contratar motoboys sob demanda, no estilo Uber, feita para usar no celular.

## Como rodar

Requisito: Node.js 22.13 ou mais novo (usa o SQLite que já vem no Node).

```bash
npm install
npm start          # ou: npm run dev  (reinicia sozinho ao salvar)
```

Abra `http://localhost:3000`. O terminal também mostra o endereço para abrir **no celular**, que precisa estar no mesmo Wi-Fi.

- **Admin:** telefone `11999145779` (a senha não fica escrita no código, só o hash, em `server/config.js`)
  - Trocar telefone/senha num banco existente (feche o MotoX antes): `npm run admin -- <telefone> <senha> [caminho do motox.db]`
  - Aba **Contas**: buscar por nome, telefone ou placa; filtrar clientes, motoboys e bloqueados; bloquear/desbloquear; excluir.
  - Uma conta **sem corridas** é apagada por completo. Uma conta **com histórico** tem os dados pessoais removidos e as corridas continuam no financeiro como "Conta excluída". Nos dois casos o telefone fica livre para novo cadastro.
  - Não é possível bloquear nem excluir quem está com uma corrida em andamento, nem contas de administrador.
- **Testes automáticos:** `npm test`

### Testando sozinho (cliente + motoboy)
1. Numa janela normal, crie uma conta **"Quero enviar"**.
2. Numa janela anônima (ou no celular), crie uma conta **"Sou motoboy"**, marque sua posição e toque em **Ficar online**.
3. Como cliente, escolha coleta e entrega e toque em **Chamar motoboy**.
4. Como motoboy, aceite a oferta. Use **🧪 Simular trajeto** para a moto andar sozinha no mapa.
5. Na entrega, digite o PIN que aparece na tela do cliente.

> No celular acessando por `http://192.168...`, o navegador bloqueia o GPS (ele exige HTTPS). Nesse caso, toque no mapa para marcar a posição. Em produção, com HTTPS, o GPS funciona normalmente.

## Cadastro de motoboys com documentos

- **Cadastro:** CNH e documento da moto (CRLV) são obrigatórios. Aceita foto (comprimida no próprio celular) ou PDF, até 6 MB cada. O formato é conferido pelo conteúdo do arquivo, não pelo nome.
- **Antes da aprovação:** a conta fica "Em análise". O motoboy entra no app, mas **não fica online** até o admin aprovar.
- **Análise no painel:** em *Contas → Em análise → Analisar*, o admin vê os documentos com uma lista do que conferir (nome, validade, categoria A, observação EAR, placa).
  - **Aprovar:** o motoboy é avisado na hora.
  - **Reprovar:** exige um motivo; o motoboy vê o motivo e reenvia só o documento pedido.
- **Onde ficam os arquivos:** em `dados/documentos/`, fora da área pública. Só o admin logado abre.
- **Contas excluídas:** ao excluir uma conta, os documentos dela são apagados (LGPD).
- **Motoboys de versões anteriores:** ficam "Em análise" e o app pede os documentos que faltam.

## Tarifas e promoções (painel admin)

**Aba Tarifas:** tudo vale na hora para os próximos pedidos.
- **Preço:** bandeirada, valor por km, valor mínimo e distância máxima.
- **Comissão e acréscimos:** comissão da MotoX, acréscimo de ida e volta e por tamanho do pacote.
- **Tarifa dinâmica:**
  - **Modo chuva:** liga e desliga com um toque.
  - **Horários de pico:** dias, início e fim, inclusive atravessando a meia-noite, no horário de Brasília.
  - **Teto do acréscimo:** limite máximo para a soma de todos os acréscimos.
  - **Repasse ao motoboy:** quanto do acréscimo vai para ele (padrão: 100%).
  - **Transparência:** o cliente vê o motivo ("⚡ Alta demanda (Chuva)") e o motoboy vê o acréscimo na oferta.
- **Simulador:** mostra quanto o cliente paga, quanto o motoboy recebe e quanto a MotoX fica, antes de salvar.
- **Histórico:** cada alteração fica registrada em `historico_tarifas`.

**Aba Promoções:** cupons com código ou automáticos.
- **Tipos:** porcentagem (com desconto máximo) ou valor fixo.
- **Regras:**
  - pedido mínimo
  - validade (início e fim)
  - limite total de usos
  - limite por cliente
  - só na primeira entrega
  - aplicação automática, sem precisar digitar o código
- **Modelos prontos:** Boas-vindas, Campanha % e R$ fixo.
- **O desconto sai da parte da MotoX:** o ganho do motoboy nunca diminui.
- **Pedido cancelado devolve o uso do cupom.**
- **Promoção já usada não pode ser excluída, só pausada,** porque ela continua no histórico financeiro.

## Executável para Windows (MotoX.exe)

```bash
npm run exe
```

Gera `dist/MotoX-Servidor/` (pasta do programa) e `dist/MotoX-Servidor.zip` (para levar a outro computador).

- **Para usar:** dois cliques em `MotoX.exe`. O servidor liga e o navegador abre sozinho. **Não precisa ter Node instalado.**
- **A pasta inteira é o programa:** `MotoX.exe` precisa das pastas `public` e `vendor` ao lado.
- **O banco fica em `dados/`,** ao lado do exe. Gerar o exe de novo preserva essa pasta, e o zip nunca a inclui.
- **Mudou o código?** Rode `npm run exe` de novo.
- **Aviso do Windows:** como o exe ainda não tem assinatura digital, o Windows pode mostrar "O Windows protegeu o computador" (*Mais informações → Executar assim mesmo*). Isso some com um certificado de assinatura de código.

## Apps Android e iOS (Capacitor)

O mesmo código de `public/` gera dois apps:

| App | Pacote | Para quem | Recursos nativos |
|---|---|---|---|
| **MotoX** | `br.com.motox.cliente` | quem envia | GPS para preencher a coleta |
| **MotoX Entregador** | `br.com.motox.entregador` | motoboys | GPS em segundo plano (continua com Waze aberto ou tela apagada) e notificação com som quando chega uma oferta |

Rastreio e painel admin continuam só na web.

```bash
npm run apps                          # gera apps/*/www apontando para o IP desta máquina (teste no Wi-Fi)
npm run apps -- https://api.seudominio.com.br   # para produção (https obrigatório nas lojas)
npm run android:entregador            # gera e abre no Android Studio
```

- **Android:** precisa do Android Studio (ou do Android SDK) e de um celular com "depuração USB" ligada.
- **iOS:** os projetos já estão em `apps/*/ios`, mas compilar exige um Mac com Xcode (ou build na nuvem).
- **Nunca edite `apps/*/www`:** é gerado a partir de `public/`. Edite `public/` e rode `npm run apps`.

## Estrutura

```
server/
  index.js      inicia o servidor
  app.js        Express + Socket.IO (tempo real)
  rotas.js      API REST
  despacho.js   oferece cada corrida ao motoboy mais próximo, com tempo limite
  precos.js     rota pelas ruas (OSRM) e cálculo de preço
  corridas.js   o que cada perfil pode ver de uma corrida
  config.js     preços, taxa, raio e tempos (ajuste aqui)
  db.js         banco SQLite (arquivo em dados/motox.db)
public/
  index.html    login e cadastro
  cliente.html  pedir entrega e acompanhar ao vivo
  motoboy.html  receber ofertas e fazer a corrida
  rastreio.html página pública para quem recebe
  admin.html    painel da operação
  js/config.js  endereço do servidor (nos apps é gerado pelo script)
  js/nativo.js  GPS em segundo plano e notificações quando roda dentro do app
apps/
  cliente/      projeto Capacitor do app MotoX (android/ e ios/)
  entregador/   projeto Capacitor do app MotoX Entregador (android/ e ios/)
scripts/
  montar-apps.js  copia public/ para os apps e configura o servidor
test/           testes automáticos do fluxo completo
```

Serviços gratuitos usados: mapas do OpenStreetMap, endereços pelo Photon e rotas pelo OSRM. Sem internet, a rota é estimada pela distância em linha reta.

Veja [ANALISE.md](ANALISE.md) para a comparação com a concorrência e as próximas fases.
