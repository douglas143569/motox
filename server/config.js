// Parâmetros de negócio centralizados — ajuste aqui sem mexer na lógica.
module.exports = {
  PORTA: Number(process.env.PORT || 3000),

  // Conta de administrador criada na primeira execução (banco vazio).
  // A senha não fica no código, só o hash (scrypt). Para trocar num banco existente:
  //   npm run admin -- <telefone> <senha>
  ADMIN: {
    telefone: process.env.ADMIN_TELEFONE || '11999145779',
    senha: process.env.ADMIN_SENHA || null, // se definida (ex.: nos testes), tem prioridade sobre o hash
    senhaHash:
      '2f51e1c76ef02e9a7a4066d29aae3f29:274da3a6471d4676a76e4b2e256b030f242726f95927274e121d2f07df970d0dd7e59dd4c57a2b02fa20de5acf7a8a4f7e43c6e49c1462ddbffd30d847542b39',
  },

  PRECO: {
    base: 7.0, // bandeirada (R$)
    porKm: 1.9, // R$ por km rodado
    minimo: 10.0, // valor mínimo de uma corrida
    taxaPlataforma: 0.15, // 15% fica com a plataforma, 85% com o motoboy
    idaVolta: 1.7, // multiplicador quando o motoboy precisa voltar à origem
    distanciaMaxKm: 80,
    tamanhos: {
      pequeno: { mult: 1.0, nome: 'Pequeno', desc: 'Até 5 kg' },
      medio: { mult: 1.25, nome: 'Médio', desc: 'Até 15 kg' },
      grande: { mult: 1.6, nome: 'Grande', desc: 'Até 25 kg' },
    },
  },

  DESPACHO: {
    tempoOfertaMs: 20000, // tempo que o motoboy tem para aceitar
    raioKm: 15, // só oferece para motoboys até esta distância da coleta
    tempoMaxBuscaMs: 3 * 60 * 1000, // depois disso a corrida expira
    varreduraMs: 4000, // intervalo da varredura de corridas pendentes
  },
};
