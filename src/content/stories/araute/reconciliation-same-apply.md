---
title: "Conciliar o extrato do Pix sem que a rede de segurança vire um segundo caminho"
summary: "Quando o aviso de um Pix se perde, o dinheiro está na conta mas a cobrança segue em aberto para o lojista. Fiz a conciliação com o extrato recuperar esses pagamentos sem creditar nada em dobro e mandar os casos duvidosos para uma pessoa."
project: araute
order: 7
tags: [Conciliação, Webhooks, Idempotência, Ledger, Pix]
---

Imagine uma madrugada em que o endpoint que recebe os avisos do provedor de Pix fica fora do ar por mais tempo do que o provedor insiste em reenviar. Um comprador pagou um Pix às 23h58. O dinheiro está na conta, mas o aviso nunca chegou, e a cobrança continua "aguardando pagamento" no painel do lojista. Alguém precisa perceber isso sem depender de um humano abrindo o extrato.

## O problema

O webhook é o jeito normal de saber que um pagamento aconteceu. É barato e rápido, mas falha. Se o endpoint fica fora além da janela de retentativa do provedor, o evento se perde. Um Pix enviado direto para a chave, sem cobrança associada, chega sem correlação nenhuma.

Eu precisava garantir as duas direções: todo dinheiro que existe no provedor tem espelho na Araute, e todo dinheiro que a Araute acredita ter existe no provedor.

## Por que não era trivial

O risco maior de uma conciliação é ela virar um segundo caminho de escrita, com regras próprias, que aos poucos diverge do primeiro. Aí ela credita de novo o que o webhook já creditou, ou reduz o saldo do lojista porque interpretou um atraso como ausência.

Há também a virada do dia. Um corte seco à meia-noite perde exatamente o Pix das 23h58 que o provedor registrou às 00h01.

E nem todo casamento entre extrato e cobrança é confiável. Dois pagamentos de R$ 50,00 no mesmo minuto são indistinguíveis se a única pista for o valor.

## A solução

### Mesmo apply, não um caminho paralelo

A conciliação não tem lógica própria de escrita. Ela transforma o que encontra no extrato num evento interno, no mesmo formato que o webhook produz, e entrega esse evento ao mesmo código: mesma normalização, mesmas guardas da máquina de estados, mesma idempotência. A deduplicação usa o identificador ponta a ponta do Pix (o end-to-end ID, que o Banco Central atribui a cada transação) e a chave determinística do lançamento contábil.

Quando a conciliação encontra um pagamento que o webhook já processou, o resultado é no-op. É isso que torna seguro rodá-la com frequência e sobre janelas que se sobrepõem.

### Janela com sobreposição

A janela base é o dia anterior fechado, mas a consulta ao provedor estende as bordas em algumas horas para cada lado. Um item da fronteira aparece em duas rodadas, e a segunda não faz nada. Prefiro reprocessar a perder.

### Casamento do mais forte ao mais fraco

Para cada item do extrato, tento casar com uma cobrança nesta ordem e paro no primeiro acerto:

1. end-to-end ID da liquidação Pix
2. identificador do QR dinâmico
3. o identificador de correlação que eu mesmo enviei, quando o provedor o devolve
4. valor mais uma janela curta de tempo

O quarto critério é ambíguo por natureza. Por isso ele nunca dispara efeito financeiro sozinho: o item vai para revisão humana, marcado como confiança fraca. A chave que produziu o casamento fica gravada, porque saber como algo foi conciliado importa tanto quanto saber que foi.

### Cada divergência é um registro

Divergência não conserta nada em silêncio. Cada item vira um registro auditável com um tipo: pago no provedor sem espelho na Araute, pago na Araute sem confirmação no provedor, valor diferente, estorno não espelhado, duplicidade.

### O que se automatiza e o que exige humano

A linha é simples. Automatizo só o que adiciona dinheiro comprovadamente presente no provedor e é idempotente, como sintetizar o evento de um pagamento cujo webhook se perdeu. Tudo que reduziria dinheiro do lojista com base na ausência de algo exige humano. A exceção é um fato irrevogável já no extrato, como um estorno executado no próprio provedor: ali o dinheiro já saiu.

Há ainda um limite de segurança. Se uma rodada fosse recuperar itens acima de um limiar, ela pausa e alerta em vez de aplicar em massa. Um bug no reconciliador não pode "recuperar" o mundo inteiro numa madrugada.

## Um exemplo

O Pix das 23h58, numa linha do tempo:

```txt
23:58:10  comprador paga R$ 50,00; o provedor liquida (e2e E1234...)
23:58:11  provedor tenta o webhook: endpoint fora do ar
00:40     provedor esgota as retentativas; o evento só existe no extrato
03:00     conciliação consulta o dia anterior, de 22:00 a 02:00
03:00     item E1234 casa pela chave 1 com a cobrança ch_789
03:00     evento sintético "pagamento confirmado" entra no mesmo apply
03:00     máquina de estados: aguardando -> pago; journal lançado
03:00     lojista recebe o webhook de pagamento confirmado
03:00+1d  rodada seguinte vê E1234 de novo na sobreposição: no-op
```

O coração disso é que webhook e conciliação chamam a mesma função:

```ts
type ProviderFact = { e2eId: string; amountCents: number; paidAt: string }

async function onWebhook(raw: ProviderPayload) {
  await applyPayment(normalize(raw))
}

async function onReconciliationItem(item: StatementItem) {
  const match = await matchStrongest(item)
  if (match.confidence === 'weak') return openReview(item, match)
  await applyPayment({ e2eId: item.e2eId, amountCents: item.amountCents, paidAt: item.paidAt })
}

async function applyPayment(fact: ProviderFact) {
  // a dedupe pelo e2eId torna a segunda chamada um no-op, venha de onde vier
  if (await alreadyApplied(fact.e2eId)) return
  // ...transição de estado, lançamento contábil e evento ao lojista
}
```

## Resultado

O webhook continua sendo o caminho principal, de baixa latência, e a conciliação é a rede de segurança que fecha os buracos. Como os dois chegam ao mesmo código, não existe uma regra que valha num e não no outro. E como o ledger é imutável, toda correção deixa rastro: um registro de conciliação, um evento interno e, quando resolvida, um lançamento novo.

## O que eu levo disso

Quando existe um caminho principal e uma rede de segurança, os dois precisam desaguar no mesmo código de aplicação. Dois caminhos de escrita sempre divergem, só não se sabe quando.
