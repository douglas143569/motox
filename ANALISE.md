# MotoX — Análise de mercado e diferenciais

## Quem já faz isso

| App | Modelo | Pontos fortes | Pontos fracos mais citados |
|---|---|---|---|
| **Uber Flash (Moto)** | Envio de pacotes dentro do app Uber | Base enorme de motoristas, chegada rápida | Feito para passageiros, não para entregas: pouca informação sobre o pacote, sem comprovante forte de entrega |
| **99Entrega** | Parecido com o Uber Flash, dentro do app 99 | Preço baixo, fácil de usar | Mesmos problemas: suporte fraco quando o pacote some |
| **Lalamove** | Marketplace de entregas (moto, carro, utilitário) | Várias paradas, cotação na hora, bom para empresas | Taxas e adicionais confusos para quem envia; motoristas reclamam da comissão |
| **Borzo** (antigo Mr. Speedy) | Entregas expressas por moto, foco em pequenas empresas | Várias paradas, pagamento na entrega | Tempo de espera maior em horário de pico |
| **Loggi** | Começou com motoboys; hoje foca em e-commerce/logística | Infraestrutura e rastreio | Pouco atendimento ao envio avulso sob demanda |
| **iFood Entrega Fácil / Envios** | Entregadores do iFood para restaurantes e lojas | Rede gigante de entregadores | Voltado para quem já é parceiro iFood |

## As dores que se repetem

**Do motoboy**
1. Aceitar corrida "no escuro": não vê quanto ganha nem para onde vai antes de aceitar.
2. Comissão alta e sem transparência.
3. Cliente cancela depois que ele já se deslocou e ele não recebe nada.
4. Espera longa na coleta sem compensação.

**De quem envia**
1. Sem prova de que o pacote chegou à pessoa certa.
2. Quem recebe não sabe quando o pacote vai chegar.
3. Suporte lento quando algo dá errado.

## O que o MotoX já faz melhor (versão 0.1)

| Diferencial | Como funciona |
|---|---|
| **Oferta transparente** | O motoboy vê antes de aceitar: quanto ganha, R$/km, quanto o cliente paga, a taxa da plataforma, distância até a coleta e o endereço de entrega |
| **Taxa justa e fixa** | 85% para o motoboy, 15% para a plataforma (ajustável em `server/config.js`) |
| **PIN de entrega** | O motoboy só finaliza digitando o código de 4 dígitos que está com quem recebe. Ele nunca vê esse código no app: é a prova de entrega |
| **Rastreio para quem recebe** | Link público com o mapa ao vivo, sem precisar instalar nada ou criar conta. Um toque envia o link e o PIN pelo WhatsApp |
| **Ida e volta** | Para documentos assinados, maquininha, troca de produto |
| **Despacho inteligente** | Oferece primeiro ao motoboy mais próximo; se ele recusar ou não responder em 20 s, passa para o próximo |
| **Desistência sem travar o cliente** | Se o motoboy desiste antes da coleta, a corrida volta automaticamente para a fila |
| **Avaliação dos dois lados** | Cliente avalia o motoboy e o motoboy avalia o cliente (a nota do cliente aparece na oferta) |
| **Sem instalar app** | Funciona no navegador do celular e pode ser adicionado à tela inicial (PWA) |

## Próximas fases (sugestão)

**Fase 2: pronto para operar de verdade**
- [ ] Publicar com HTTPS (necessário para GPS e notificações no celular)
- [ ] Pagamento real por Pix/cartão com divisão automática do valor (Mercado Pago, Asaas ou Efí)
- [ ] Taxa de cancelamento tardio, paga ao motoboy que já se deslocou
- [ ] Taxa de espera: tempo grátis na coleta e depois cobrança por minuto
- [ ] Foto do pacote na coleta e na entrega
- [ ] Notificações push (oferta tocando com o app em segundo plano)
- [ ] Cadastro do motoboy com análise de CNH, CRLV e selfie
- [ ] Banco PostgreSQL e provedor de mapas com chave (MapTiler/Mapbox)

**Já feito além do plano:** tarifas editáveis no painel com simulador, cupons e promoções automáticas.

**Fase 3: crescer**
- [ ] Várias paradas numa corrida (rota otimizada)
- [ ] Agendamento de entregas
- [x] Preço dinâmico transparente (chuva/pico), com o motivo exibido ao cliente (feito: o acréscimo vai para o motoboy)
- [ ] Gorjeta
- [ ] Conta empresa: faturamento mensal, vários usuários, API para lojas
- [ ] Chat dentro do app
- [ ] Apps nativos na loja (Capacitor, reaproveitando este código)
