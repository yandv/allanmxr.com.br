---
title: Tratar a resposta perdida do órgão emissor como um estado, sem duplicar a nota
summary: "Quando a resposta do órgão emissor se perde, a nota fiscal pode ter sido emitida mesmo assim, e reenviar duplicaria a nota do cliente. Passei a tratar essa dúvida como um estado próprio e só sigo depois de confirmar o que aconteceu."
project: araute
order: 10
tags: [NFS-e, Idempotência, Máquinas de estado, Reconciliação, TypeScript]
---

Um lojista vende uma consultoria, o pagamento é confirmado e a Araute emite a nota fiscal automaticamente. A requisição sai para o órgão emissor e, segundos depois, estoura o timeout. Do meu lado não há nota nem rejeição, só silêncio. Do lado do órgão, a nota pode muito bem ter sido gerada um segundo antes de a conexão cair. Se eu interpretar o silêncio como falha e mandar de novo com outro número, o tomador do serviço recebe duas notas pela mesma venda.

## O problema

A emissão de NFS-e (a nota fiscal de serviço eletrônica) no padrão nacional é uma chamada síncrona. Envio uma DPS, a declaração de prestação de serviço assinada que o órgão transforma em nota, e ele responde com a nota ou com a rejeição.

Cada DPS tem série e número, e o número é reservado do meu lado, numa transação, antes do envio. Rede e timeout podem perder a resposta de uma nota que o órgão gerou. Nota duplicada não é um detalhe: cancelar exige processo próprio e gera confusão contábil para o lojista e para o cliente dele.

## Por que não era trivial

Resposta perdida não é rejeição e não é sucesso. É um terceiro resultado que uma máquina de "enviado, emitido, falhou" não representa. E "tentar de novo" carrega uma armadilha: a vontade natural de pegar o próximo número livre.

Havia ainda uma variante pior. O mesmo CNPJ pode emitir notas por outro sistema, como o emissor web do governo ou um ERP do lojista. Esse outro sistema pode ocupar justamente o número que eu reservei, e o órgão responde "esse número já existe". Só que eu consulto a nota pelo identificador derivado do número. Achar uma nota ali não prova que ela é minha.

## A solução

### "Não sei" é um estado

A máquina interna de emissão ganhou um estado de resultado desconhecido, alcançado depois do envio quando a resposta se perde. Para o lojista, o status público continua "processando", porque para ele nada mudou. Internamente, esse estado tem regras próprias e uma fila própria.

### Reconciliar antes de qualquer retry

Nenhuma nota sai desse estado por um novo envio. Primeiro consulto o órgão pelo identificador da DPS, que é determinístico: série, número e CNPJ sempre geram o mesmo identificador. Checo a existência e, se existir, busco a nota.

Se a nota existe e é minha, a nota passa para emitida, com os dados que o órgão gerou. Se não existe, o retry é liberado, com o mesmo número. Uma rotina periódica drena o que ficou parado nesse estado.

### Nunca um número novo por timeout

O número foi fixado na reserva e não muda por causa de uma falha de rede. O identificador determinístico é a segunda defesa: reenviar a mesma DPS não cria uma segunda nota, porque o órgão a reconhece.

### Prova de autoria

Quando o órgão diz que o número já existe, não assumo nada. Busco a nota e leio o bloco da DPS que vem embutido nela, ou seja, o que o emissor declarou, e não os campos que o órgão preencheu.

1. Se série, número ou CNPJ do prestador não batem com o que pedi, ou o bloco está ilegível, não há prova.
2. Se a versão de aplicativo declarada não é a minha, a nota é de outro sistema.
3. Se é a minha, comparo a impressão digital da venda: documento do tomador, código de tributação e valor em centavos. Tudo igual, a nota é nossa e eu a adoto. Algo diferente, é de outro sistema.

Nota de outro sistema é a única exceção à regra de nunca trocar de número. Nesse caso registro a ocupação externa, reservo o próximo número e reenvio, com um teto de saltos. Esgotado o teto, a emissão falha de vez e dispara um alerta.

### Sem prova, nada muda

Consulta que falhou, erro do lado do órgão ou XML ilegível mantêm a nota no estado de resultado desconhecido, com alerta. A próxima rodada da reconciliação tenta de novo. O sistema prefere esperar a decidir no escuro.

## Um exemplo

Uma linha do tempo com valores fictícios. Nota de R$ 1.250,00 para o tomador de CNPJ 12.345.678/0001-90, DPS série 1, número 4821.

```txt
t=0s      reserva o número 4821 (transação confirmada)
t=0.2s    POST da DPS 4821 ao órgão
t=15s     timeout, nenhuma resposta
          estado interno: resultado desconhecido; status público: processando
t=5min    reconciliação: consulta pelo identificador da DPS 4821
          resposta: existe
t=5min    busca a nota e lê o bloco da DPS embutido
          versão do aplicativo: a nossa
          tomador 12345678000190, código 01.07.01, valor 125000 centavos: confere
          resultado: nota nossa, adotada como emitida
```

O desfecho alternativo, quando outro sistema ocupou o número:

```txt
t=0.2s    POST da DPS 4821
t=0.6s    órgão responde: número já utilizado
t=0.9s    busca a nota 4821 e lê o bloco da DPS
          versão do aplicativo: outra
          resultado: ocupação externa registrada
t=1.0s    reserva o 4822 e reenvia
t=1.4s    nota emitida com o número 4822
```

E o caso em que a consulta também falha: o órgão devolve erro 503 às duas tentativas da reconciliação. A nota fica em processando, com alerta, e a decisão espera a próxima rodada. Em nenhum desses caminhos sai uma segunda nota para a mesma venda.

A ideia da prova cabe numa função pura:

```ts
type Ownership = 'ours' | 'foreign' | 'no_proof'

function proveOwnership(dps: EmbeddedDps | null, sale: ExpectedSale): Ownership {
  if (!dps) return 'no_proof'
  const sameSlot =
    dps.number === sale.number && dps.series === sale.series && dps.cnpj === sale.cnpj
  if (!sameSlot) return 'no_proof'
  if (dps.appVersion !== OUR_APP_VERSION) return 'foreign'
  const sameSale =
    dps.recipientDocument === sale.recipientDocument &&
    dps.serviceCode === sale.serviceCode &&
    dps.amountCents === sale.amountCents
  return sameSale ? 'ours' : 'foreign'
}
```

## Resultado

Resposta perdida deixou de ser um caminho para nota duplicada. O pior caso do desenho agora é uma nota parada em "processando" com um alerta, esperando prova, e não uma emissão repetida. O backlog desse estado virou métrica, então uma degradação do órgão aparece como fila crescendo antes de virar reclamação de lojista.

## O que eu levo disso

Em integração com sistema externo, "não sei" é um estado, não um erro. Modelar a dúvida de forma explícita é o que impede a decisão errada tomada no escuro. E prova de autoria tem que vir do que eu declarei, não de um identificador que outro sistema também pode ocupar.
