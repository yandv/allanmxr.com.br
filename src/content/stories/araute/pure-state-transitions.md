---
title: Estado de pagamento só muda por uma função pura que devolve efeitos
summary: "Cancelamento, confirmação do banco e expiração podem chegar ao mesmo pagamento no mesmo segundo e, se cada caminho decidir sozinho, o dinheiro termina numa cobrança cancelada. Centralizei toda mudança de estado numa única regra testada, que nenhum caminho contorna."
project: araute
order: 4
tags: [Máquinas de estado, TypeScript, Domain-Driven Design, Zod, OpenAPI]
---

Um pagamento Pix está em processamento. No mesmo segundo, três coisas acontecem: o lojista chama a API para cancelar, o webhook do provedor avisa que o dinheiro caiu e o Cron que expira pagamentos antigos passa por ali. Três escritas concorrentes sobre o mesmo registro, cada uma com sua própria ideia do que deveria acontecer. Se cada caminho decidir sozinho, o estado final é o de quem escreveu por último, e o dinheiro do comprador pode terminar numa cobrança marcada como cancelada.

## O problema

Os objetos com ciclo de vida próprio na Araute são vários: o PaymentIntent (a intenção de cobrar um valor, que atravessa várias tentativas de pagamento até ser paga ou cancelada), a cobrança, a tentativa de pagamento, a assinatura, o reembolso, a disputa, o documento fiscal, o repasse, entre outros. As mudanças de estado chegam de quatro origens: a API do lojista, o webhook do provedor, os jobs agendados e a conciliação.

Sem uma regra única, cada origem acaba reimplementando um pedaço da lógica, e as versões divergem. Bug de corrida, numa plataforma de pagamentos, vira dinheiro no lugar errado.

## Por que não era trivial

O difícil não é o caminho feliz. É o que não pode acontecer.

Um pagamento já pago não pode voltar a "aguardando método de pagamento". Um PaymentIntent expirado que recebe dinheiro depois não vira "pago", porque a liquidação Pix é irrevogável e isso é uma anomalia para a conciliação tratar, não uma transição comum. Um PaymentIntent em processamento não pode ser cancelado pela API, porque o dinheiro pode estar liquidando naquele instante.

Essas regras precisam valer igual para as quatro origens e precisam ser testáveis sem subir banco, sem fila e sem mock de relógio.

## A solução

### Primeiro a regra no papel, depois no código

Para cada objeto, escrevi a máquina de estados como documentação canônica: diagrama, tabela de transições, estados terminais e a lista das transições proibidas mais perigosas, cada uma com o motivo. Só depois ela virou código.

### Uma assinatura para todas as transições

Toda transição, de qualquer objeto, tem o mesmo formato: recebe o estado atual e um evento e devolve um resultado. O resultado é ou sucesso, com o próximo estado e uma lista de efeitos, ou um erro tipado, com um de três tipos: transição ilegal, guarda que falhou ou replay sem efeito.

A função é pura. Tudo que ela precisa saber (o instante, os IDs, os valores liquidados) chega dentro do evento, montado pela camada de fora. Não existe um objeto de contexto paralelo. Isso permite testar por igualdade de dados, sem mock.

### Efeitos como dados

A função não faz I/O. Em vez de emitir o evento ou lançar no livro-razão, ela devolve uma lista de efeitos descritos como dados: emitir evento de domínio, invalidar cache, lançar um journal contábil, enfileirar uma nota fiscal. Quem executa essa lista é a camada de serviço, dentro da transação do banco. Os efeitos que dependem de commit, como enfileirar webhooks, só rodam depois dele.

### Dois erros que merecem atenção

O replay sem efeito é o caso idempotente: o evento já foi aplicado, e a camada de fora trata como sucesso silencioso. É ele que deixa o webhook duplicado e a conciliação rodarem sobre um pagamento já processado sem quebrar nada.

A transição ilegal carrega um código estável, como `payment_intent_unexpected_state`. Quando a causa é uma chamada da API, esse código vira a resposta de erro no formato Problem Details da RFC 7807, e o integrador pode ramificar por ele.

### Fora de ordem não conserta, descarta

Um evento que chega no estado errado vira replay sem efeito ou erro. Nunca vira um UPDATE para "consertar" o estado.

### Status com uma fonte só

Cada família de status é um objeto constante em TypeScript com o tipo derivado dele. O mesmo objeto alimenta o schema Zod da API e a restrição CHECK da coluna no PostgreSQL. O contrato OpenAPI é gerado a partir dos schemas Zod, e os painéis geram seus tipos a partir do contrato. Um status novo nasce num lugar e chega a todos pelo contrato, ou o build quebra.

## Um exemplo

Um recorte da máquina do PaymentIntent, com nomes simplificados, mostra o formato:

```ts
type Result<S> =
  | { next: S; effects: Effect[] }
  | { kind: 'illegal' | 'guard_failed' | 'noop_replay'; code: string; from: S }

function transitionIntent(current: IntentStatus, event: IntentEvent): Result<IntentStatus> {
  switch (event.type) {
    case 'payment_confirmed':
      // a duplicate webhook or a reconciliation pass lands here: success, no side effects
      if (current === 'succeeded') return noop(current)
      if (current !== 'processing') return illegal('payment_intent_unexpected_state', current)
      return { next: 'succeeded', effects: [emit('payment_intent.succeeded'), bumpCache('intents')] }

    case 'cancel':
      // money may be settling while processing, so only pre-network states can cancel
      if (current === 'processing' || current === 'succeeded') {
        return illegal('payment_intent_unexpected_state', current)
      }
      return { next: 'cancelled', effects: [emit('payment_intent.cancelled')] }
  }
}
```

E o teste vira uma tabela de entrada e saída, sem banco:

| Estado atual | Evento | Resultado |
| --- | --- | --- |
| processing | payment_confirmed | succeeded, emite `payment_intent.succeeded` |
| succeeded | payment_confirmed | replay sem efeito |
| requires_payment_method | payment_confirmed | ilegal, `payment_intent_unexpected_state` |
| processing | cancel | ilegal, `payment_intent_unexpected_state` |
| requires_action | cancel | cancelled, emite `payment_intent.cancelled` |

Voltando à cena de abertura: o cancelamento do lojista recebe um erro claro, o webhook confirma o pagamento, e o Cron de expiração, se chegar depois, é recusado pela guarda, porque só expira o que ainda espera pagamento. O estado pago não se move.

## Resultado

A máquina de estados virou a única porta para mudar estado, e as regras mais perigosas ficaram escritas como proibições com motivo, no documento e no código. Os testes de transição são tabelas rápidas, sem infraestrutura. E descrever efeitos como dados facilitou uma garantia que parecia separada: nenhum trabalho em segundo plano sobrevive a um rollback, porque a camada que executa os efeitos sabe quais dependem do commit.

## O que eu levo disso

Separar decidir de executar. Uma função pura que devolve o próximo estado e a lista de efeitos é fácil de testar, fácil de ler em code review e difícil de usar errado. E escrever as transições proibidas antes das permitidas muda o foco do desenho: o caminho feliz se escreve sozinho, o que pede atenção é o que nunca pode acontecer.
