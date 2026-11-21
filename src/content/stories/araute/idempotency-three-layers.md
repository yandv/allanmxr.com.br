---
title: Reservar o ID antes de cobrar para um retry nunca virar segunda cobrança
summary: "Uma requisição repetida por queda de rede, deploy ou fila não pode virar uma segunda cobrança. Desenhei idempotência em cada uma dessas fronteiras, e repetir um pedido devolve o resultado do primeiro em vez de cobrar de novo."
project: araute
order: 1
tags: [Idempotência, Idempotency-Key, PostgreSQL, Cloudflare Queues, Pagamentos]
---

Um lojista cria uma cobrança de R$ 150,00 pela API. A requisição sai, a rede do servidor dele oscila e o cliente HTTP não recebe resposta. A biblioteca faz o que toda biblioteca faz: tenta de novo. Do lado da Araute, a primeira requisição já tinha chegado e estava conversando com o provedor de pagamento. Se o segundo POST for tratado como novo, o comprador recebe duas cobranças, e o lojista descobre pelo suporte.

## O problema

Cobrar duas vezes é o pior bug de uma plataforma de pagamentos, e ele não tem uma origem só. O cliente da API repete o POST porque a rede caiu. O Worker é reiniciado no meio de uma requisição por causa de um deploy. A fila entrega a mesma mensagem duas vezes. O provedor reenvia o mesmo webhook. Cada fonte de duplicação acontece numa fronteira diferente do sistema, então uma defesa única na borda da API não cobre as outras.

## Por que não era trivial

Três fatores se somam.

O primeiro é a execução distribuída. Vários isolates do Cloudflare Workers (instâncias leves e efêmeras do runtime, sem memória compartilhada entre si) atendem requisições ao mesmo tempo. Um lock em memória não serve. O lock precisa morar no banco.

O segundo é a entrega da fila. O Cloudflare Queues garante entrega pelo menos uma vez, nunca exatamente uma vez. Todo consumidor precisa aceitar a mesma mensagem repetida sem repetir o efeito.

O terceiro é o mais traiçoeiro. A chamada ao provedor também precisa de uma chave de idempotência, e essa chave tem que ser a mesma entre tentativas. Se ela deriva de um ID gerado dentro da lógica de negócio, cada reexecução gera um ID novo, uma chave nova, e o provedor cria um segundo recurso de boa-fé.

## A solução

Separei o problema em três camadas independentes, cada uma com sua chave e sua janela de validade.

### Camada 1: a API pública

Todo POST que cria ou cobra exige o header `Idempotency-Key`. A regra está na [documentação pública](https://docs.araute.com/comece-aqui/idempotencia): mesma chave e mesmo corpo devolvem a resposta original; mesma chave com corpo diferente responde 422, porque é erro de uso; chave ainda em processamento responde 409.

Por dentro, a própria linha da chave no banco é o lock, com unicidade por conta e por endpoint. Ela guarda um hash SHA-256 do corpo em forma canônica, o que permite distinguir replay legítimo de reuso indevido mesmo que o JSON chegue com as chaves em outra ordem.

Respostas 2xx e 4xx determinísticas ficam gravadas para replay. Respostas 5xx não. Um erro transitório não pode ficar colado na chave por três dias: o cliente precisa poder repetir a mesma chave e de fato reexecutar.

### Camada 2: a chamada ao provedor

A chave enviada ao provedor é determinística e deriva de um ID interno já persistido, nunca de um valor aleatório gerado na hora da chamada. Retry só é seguro com a mesma chave.

### Camada 3: a ingestão e as filas

O evento bruto do provedor é deduplicado pelo par provedor e ID do evento. Jobs de fila são idempotentes pela chave natural do efeito: a renovação de uma assinatura tem unicidade por assinatura e início do período, então reprocessar o job não cria uma segunda fatura.

### O buraco entre a camada 1 e a camada 2

Revisando o desenho, achei uma falha na frase "a chave deriva de um ID já persistido". Ela não dizia quando esse ID nascia. Se ele fosse gerado durante a execução da lógica de negócio, o cenário abaixo criava uma cobrança dupla: o Worker cria o pagamento no provedor, morre antes de gravar a resposta, e o retry encontra um lock órfão (uma chave reservada cuja requisição nunca terminou). Ao retomar, a lógica gera outro ID, outra chave de provedor, e o provedor cobra de novo.

A correção foi tirar a geração do ID da lógica de negócio. O ID do recurso passa a ser reservado na mesma linha da chave de idempotência, no mesmo INSERT que pega o lock, antes de qualquer I/O externo. Toda execução para aquela chave lê esse ID em vez de criar outro.

## Um exemplo

O trecho abaixo é uma versão simplificada da reserva. O ponto central é que o ID nasce junto com o lock, em SQL, e não dentro do serviço.

```ts
async function reserveKey(db: Db, req: IncomingRequest) {
  const row = await db
    .insertInto('request_locks')
    .values({
      accountId: req.accountId,
      endpoint: req.endpoint,
      key: req.idempotencyKey,
      bodyHash: sha256(canonicalJson(req.body)),
      // the aggregate ID is born here, with the lock, so every retry reuses it
      resourceId: sql`uuidv7()`,
    })
    .onConflict((oc) => oc.columns(['accountId', 'endpoint', 'key']).doNothing())
    .returning(['id', 'resourceId'])
    .executeTakeFirst()

  if (row) return { kind: 'fresh', resourceId: row.resourceId }
  return { kind: 'existing' } // replay, 409 in flight, or resume an orphan
}
```

E a linha do tempo do caso que motivou a mudança, com e sem a reserva:

| Momento | Sem reserva | Com reserva |
| --- | --- | --- |
| t=0 | POST chega, lock criado | POST chega, lock criado com ID `01J...A7` |
| t=30ms | serviço gera ID `X`, cobra no provedor com chave `X` | serviço usa `01J...A7`, cobra com chave `01J...A7` |
| t=900ms | Worker reiniciado antes de gravar a resposta | Worker reiniciado antes de gravar a resposta |
| t=5s | retry retoma o lock órfão | retry retoma o lock órfão |
| t=5,03s | serviço gera ID `Y`, cobra com chave `Y` | serviço lê `01J...A7`, chama o provedor com a mesma chave |
| Resultado | duas cobranças | o provedor devolve a cobrança existente |

Nas operações que movem dinheiro para fora, como reembolso e repasse, fui mais conservador: um lock órfão não é retomado. A API responde 409 com um código específico e o cliente precisa decidir conscientemente, com uma chave nova.

## Resultado

Retry virou replay, nunca segunda execução. A regra ficou registrada como invariante do projeto: reexecutar uma criação confiando na deduplicação do provedor, com uma chave gerada pela própria execução, é proibido. Isso também virou critério na escolha de provedores. Um adaptador cujo provedor não aceita consulta por uma chave nossa precisa resolver a idempotência de outro jeito. "Consultar antes de criar" não serve como substituto, porque abre uma janela de corrida entre a consulta e a criação.

## O que eu levo disso

Idempotência não é um header. É uma propriedade de cada fronteira onde pode haver repetição: a API, a chamada externa, a fila, o webhook. E a chave de uma fronteira interna precisa existir antes da primeira tentativa, não ser gerada durante ela. Quando eu desenho um fluxo novo, a pergunta que faço primeiro é: se este processo morrer na linha seguinte, o que a próxima tentativa vai ler?
