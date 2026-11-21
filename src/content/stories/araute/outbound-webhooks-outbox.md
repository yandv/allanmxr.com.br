---
title: Avisar o lojista só do que o banco já confirmou, com outbox e entrega por endpoint
summary: "Um webhook disparado antes do commit pode anunciar ao lojista um pagamento que o rollback desfaz, e ele libera um pedido que não foi pago. Gravei o evento na mesma transação do pagamento e só envio depois do commit, com reenvio garantido quando o sistema dele cai."
project: araute
order: 3
tags: [Webhooks, Outbox transacional, HMAC, Cloudflare Queues, PostgreSQL]
---

Imagine um lojista que recebe às 10h15 o evento `payment_intent.succeeded` de um pedido de R$ 240,00. O sistema dele libera o pedido e manda o produto para separação. Dez minutos depois, a equipe consulta a API para emitir a nota e não encontra o pagamento confirmado. O webhook teria saído no meio da requisição, e a transação que mudava o estado teria dado rollback logo em seguida. O lojista seria avisado de um estado que nunca chegou ao banco. Esse é o cenário que o desenho da entrega precisava tornar impossível.

## O problema

A Araute avisa o lojista por webhook sempre que um objeto muda de estado: pagamento confirmado, assinatura renovada, nota emitida. O contrato parece simples, mas o momento do disparo importa. Se o aviso sai antes de a transação confirmar, qualquer falha depois dele gera um evento fantasma. E um único evento fantasma basta para o lojista parar de confiar em todos os outros.

## Por que não era trivial

Entrega confiável de webhook tem várias tensões ao mesmo tempo.

O endpoint do lojista pode ficar fora do ar por horas ou dias, e os eventos desse período não podem se perder. Um endpoint lento não pode atrasar a entrega para os outros lojistas. O segredo de assinatura precisa poder ser trocado sem derrubar quem já integrou. E, como a ordem de chegada entre eventos diferentes não é garantida numa entrega com retentativas, o formato do evento precisa funcionar para quem deduplica e reconsulta o estado.

Por fim, no Cloudflare Workers o trabalho em segundo plano costuma ser agendado com `waitUntil`, que roda independentemente do destino da transação. Um `waitUntil` agendado no meio da requisição sobrevive a um rollback.

## A solução

### Outbox na mesma transação

O evento é gravado na mesma transação que muda o estado do objeto. Esse é o padrão outbox transacional: em vez de chamar o mundo externo de dentro da transação, eu gravo a intenção numa tabela, e alguém lê essa tabela depois. Se a transação dá rollback, o evento some junto com a mudança de estado. Se confirma, os dois existem.

### Efeito só depois do commit

Para o disparo, a camada HTTP abre a transação da requisição e oferece uma variação do `waitUntil` que só agenda a tarefa depois do commit. No rollback, a tarefa é descartada. Assim, enfileirar as entregas no Cloudflare Queues nunca acontece para um estado que não existe.

### Uma entrega por endpoint

Cada evento gera uma entrega para cada endpoint inscrito naquele tipo de evento, e a agenda de retentativas é por entrega. Um endpoint lento ou fora do ar acumula as próprias tentativas sem afetar os outros. A entrega tem quatro estados: pendente, sucesso, falha (que volta a ser tentada enquanto houver agenda) e morta, que é terminal.

### Assinatura com rotação de segredo

Cada entrega leva o header `Araute-Signature` no formato `t=<timestamp>,v1=<assinatura>`. A assinatura é um HMAC-SHA256 sobre `timestamp.corpo`, onde o corpo são os bytes exatos enviados. O consumidor rejeita timestamps com mais de 300 segundos de diferença do relógio dele, o que protege contra replay, e compara em tempo constante.

Na troca de segredo, o antigo continua válido por 24 horas e o header passa a levar duas assinaturas `v1`. O consumidor aceita se qualquer uma conferir. O lojista troca o segredo no próprio ritmo, sem janela de indisponibilidade.

### Retentativa com jitter

São até 12 tentativas ao longo de cerca de três dias, com intervalos crescentes e uma variação aleatória de até 20% em cada um. O jitter evita que muitas entregas falhadas no mesmo minuto, como numa virada de mês com muitas renovações de assinatura, voltem todas juntas no mesmo instante. Qualquer resposta fora de 2xx conta como falha, inclusive redirecionamento, porque não sigo 3xx. A espera por resposta é de 10 segundos.

Esgotada a agenda, a entrega vira morta. Ela nunca é reaberta: reenviar um evento cria uma entrega nova, e o histórico da antiga fica intacto. Um endpoint com entrega morta há sete dias e nenhum sucesso no período é desativado automaticamente.

### O contrato com o consumidor

O envelope traz o `id` do evento, o tipo, a versão da API e uma fotografia do objeto no momento do commit. A [documentação pública](https://docs.araute.com/comece-aqui/webhooks) orienta o lojista a deduplicar pelo `id`, a não depender de ordem e a consultar a API quando a decisão for crítica.

## Um exemplo

A diferença entre o disparo ingênuo e o pós-commit cabe em poucas linhas. Primeiro, o jeito que gera o evento fantasma:

```ts
await db.transaction(async (trx) => {
  await trx.updateTable('payments').set({ status: 'succeeded' }).where('id', '=', id).execute()
  await notifyMerchant(id) // already left the building
  await ledger.post(trx, id) // throws: the transaction rolls back, the webhook does not
})
```

Depois, com outbox e agendamento após o commit:

```ts
await db.transaction(async (trx) => {
  await trx.updateTable('payments').set({ status: 'succeeded' }).where('id', '=', id).execute()
  const eventId = await trx.insertInto('outbox_events').values(snapshotOf(id)).returning('id').execute()
  await ledger.post(trx, id)
  // scheduled only if the commit succeeds; dropped on rollback
  afterCommit(() => queue.send({ eventId }))
})
```

E como fica a agenda de uma entrega para um endpoint que ficou fora do ar por algumas horas:

| Tentativa | Momento aproximado | Resposta | Estado |
| --- | --- | --- | --- |
| 1 | 10h15 | timeout | falha |
| 2 | 10h16 | 503 | falha |
| 3 | 10h21 | 503 | falha |
| 4 | 10h51 | 301 | falha (redirect não é seguido) |
| 5 | 11h53 | 200 | sucesso |

## Resultado

Todo evento entregue corresponde a um estado gravado no banco. O lojista consegue trocar o segredo sem parar a integração, recuperar uma janela de indisponibilidade com reenvio e deduplicar com um identificador estável. Do lado da operação, o backlog de retentativas e as entregas mortas viram métrica com alerta, o que permite agir antes de a agenda esgotar.

## O que eu levo disso

O outbox na mesma transação custa uma tabela e um consumidor, e elimina uma classe inteira de inconsistência. Eu faria de novo mesmo num sistema pequeno. A outra lição é escrever o contrato pensando no consumidor que vai errar: deduplicação por `id`, ordem não garantida e "consulte a API antes de decidir" precisam estar na documentação, não só na minha cabeça.
