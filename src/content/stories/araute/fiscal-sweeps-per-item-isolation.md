---
title: Rotinas fiscais em que uma nota com dado ruim falha sozinha
summary: "Numa rotina periódica sobre uma lista, uma única nota com dado inesperado não pode parar as outras nem deixar conexão presa no banco. Fiz cada item falhar sozinho e ficar registrado para investigação, e os drenos rodarem em sequência para o pool sempre voltar inteiro."
project: araute
order: 11
tags: [Cron, Cloudflare Workers, PostgreSQL, Resiliência, NFS-e]
---

A parte fiscal da Araute tem um conjunto de rotinas que rodam sozinhas, de tempos em tempos, pelo Cron do Cloudflare Workers. Elas conferem notas pendentes no órgão emissor, retomam trabalho que ficou parado, recuperam reservas expiradas, refazem tentativas automáticas e montam lotes de RPS por estabelecimento (o RPS é o recibo provisório de serviço, que alguns municípios ainda exigem em lote antes de virar nota). Em um dia comum, ninguém olha para elas, e é por isso que o caminho de falha delas precisa ser pensado antes: imagine uma única nota com um dado inesperado impedindo todas as outras de andar.

## O problema

Cada varredura processa uma lista de itens: notas a conferir, estabelecimentos com lote a montar. Revisando o caminho de falha da primeira versão, encontrei duas fragilidades que andavam juntas.

A primeira: um item cujos próprios dados causassem uma exceção abortaria a varredura inteira. E, como as varreduras rodavam uma atrás da outra dentro do mesmo disparo do Cron, as que vinham depois na sequência também não rodariam. Uma nota ruim no começo da fila bloquearia a conferência de todas as outras e ainda impediria a montagem dos lotes.

A segunda: quando um dreno falhasse, ficariam conexões do pool do banco sem ser devolvidas.

E o efeito se repetiria. A cada rodada, o mesmo item ruim estaria no mesmo lugar da fila e pararia tudo de novo.

## Por que não era trivial

Nenhuma das duas falhas aparece no caminho feliz. Com dados bem formados, o laço processa tudo e o pool fica limpo. O problema só surge quando um item específico tem um dado que ninguém previu, e esse item pode demorar para aparecer.

O erro de um item é uma informação sobre aquele item, não sobre o lote. Mas o laço da primeira versão tratava o lote como uma unidade: o primeiro `throw` saía de tudo e subia até o handler do Cron.

A concorrência piorava. Os drenos eram disparados em paralelo com `Promise.all`, cada um segurando sua conexão. O `Promise.all` rejeita assim que a primeira promessa falha, mas não cancela as outras. Elas seguem em voo, com conexões abertas, depois que o handler já desistiu. No Workers, o trabalho que sobra depois do fim da invocação não tem garantia de terminar, então a conexão podia simplesmente não voltar ao pool.

## A solução

### Isolamento por item

Cada item do laço ganhou o próprio `try/catch`. O erro é registrado com contexto estruturado, o ID do documento ou do estabelecimento, nunca dados do cliente, e o laço segue para o próximo.

O retorno da varredura também mudou. Na primeira versão ela devolvia o tamanho da lista, como se tudo tivesse dado certo. Agora devolve quantos itens foram de fato processados. Assim a métrica da rodada mostra a diferença entre "havia 40 itens" e "processei 39".

A montagem de lotes seguiu a mesma regra: cada grupo por estabelecimento é montado dentro do seu próprio `try/catch`. Um estabelecimento com cadastro incompleto não impede o lote dos outros.

### Drenos em sequência

Troquei o `Promise.all` por `await` um após o outro, tanto nas rotinas fiscais quanto nos relatórios de métricas do Cron. Cada dreno termina, e devolve sua conexão, antes de o próximo começar. Uma falha não deixa conexão pendurada.

Perdi paralelismo, e aceitei a troca de propósito. As varreduras rodam em segundo plano, com lote limitado, e ninguém espera por elas em tempo real. Alguns segundos a mais por rodada custam menos que um pool que vaza quando algo dá errado.

### Testar o caminho de falha

Adicionei um teste que força um dreno fiscal a falhar e confere que a rodada segue para os próximos. O caminho de erro passou a ser testado como o caminho feliz sempre foi.

## Um exemplo

Na primeira versão, o laço de conferência tinha esta forma:

```ts
async function reconcileDue(docs: DueDocument[]): Promise<number> {
  for (const doc of docs) {
    await reconcileOne(doc.id) // um throw aqui aborta o laço e a rodada inteira
  }
  return docs.length // conta até o que não foi processado
}

async function runFiscalSweeps() {
  await Promise.all([reconcileSweep(), retrySweep(), buildRpsBatches()])
}
```

Na versão final:

```ts
async function reconcileDue(docs: DueDocument[]): Promise<number> {
  let done = 0
  for (const doc of docs) {
    try {
      await reconcileOne(doc.id)
      done += 1
    } catch (error) {
      log.error('fiscal reconciliation failed', { documentId: doc.id, error: String(error) })
    }
  }
  return done
}

async function runFiscalSweeps() {
  await reconcileSweep()
  await retrySweep()
  await buildRpsBatches()
}
```

Na prática, uma rodada com 40 notas pendentes, em que a nota 7 tem um código de município que não existe na tabela:

| Item | Primeira versão | Versão final |
| --- | --- | --- |
| Notas 1 a 6 | conferidas | conferidas |
| Nota 7 | exceção, varredura abortada | erro registrado com o ID |
| Notas 8 a 40 | não rodam | conferidas |
| Lotes de RPS | não rodam | montados |
| Retorno da rodada | erro | 39 processadas |
| Próxima rodada | mesmo bloqueio | só a nota 7 continua pendente |

A nota 7 continua com problema, e deve continuar visível até alguém corrigir o dado. A diferença é que ela virou um item com alerta, e não o motivo de o resto da fila parar.

## Resultado

Um dado ruim é um item registrado, com o identificador certo para investigar, e não um bloqueio da rodada inteira. Uma varredura não deixa as seguintes sem rodar, e o pool não vaza conexão no caminho de falha. A contagem de processados por rodada também é honesta, o que tornou visível a diferença entre "a fila está vazia" e "a fila está travada".

## O que eu levo disso

Em job periódico sobre uma lista, a primeira pergunta é se a falha de um item deve parar os outros. Quase nunca deve. A segunda é se o paralelismo vale o custo no caminho de falha, principalmente quando os itens disputam um recurso compartilhado como um pool de conexões. `Promise.all` é ótimo para o caso feliz e traiçoeiro para o resto, porque desiste rápido e deixa o trabalho dos outros solto.
