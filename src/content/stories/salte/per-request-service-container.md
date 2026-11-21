---
title: Injeção de dependência num Worker, sem framework e sem container no boot
summary: "Montar serviços à mão em cada chamada espalhava código repetido pela API, e um framework de injeção pesaria no cold start e tropeçaria nos ciclos entre serviços. Fiz um container por requisição, preguiçoso e tipado, que segue a troca entre conexão e transação."
project: salte
order: 16
tags: [Injeção de dependência, Cloudflare Workers, TypeScript, Arquitetura, Knex]
---

Um desenvolvedor novo abre o serviço de cobranças da Salte para entender como uma fatura é paga. Antes de chegar na regra, ele atravessa uma dúzia de linhas que só constroem outros serviços: o de faturas, o de assinaturas, o de notificações, cada um com o contexto da requisição passado à mão. Em outro arquivo, as mesmas construções se repetem. E bastava passar o contexto errado em um desses pontos para um serviço gravar fora da transação da requisição. Esse era o custo diário de não ter uma forma única de pegar um serviço.

## O problema

A API da Salte é um ERP grande, escrito em Hono sobre Cloudflare Workers, com um serviço por domínio: assinaturas, cobranças, faturas, agenda, prontuário, financeiro. Os serviços se chamam o tempo todo. A forma de obter um deles era uma fábrica chamada em cada ponto de uso, recebendo a classe e o contexto. Só nos cinco módulos que mais usavam esse padrão havia centenas de chamadas.

Isso tinha três custos. Repetição, porque cada método reconstruía o que precisava. Desperdício, porque o mesmo serviço era construído várias vezes na mesma requisição. E risco, porque o contexto carrega a conexão com o banco, e na Salte essa conexão muda no meio da requisição.

## Por que não era trivial

A resposta de livro é um framework de injeção de dependência. Eles costumam depender de reflexão e decorators, que acrescentam peso ao bundle e trabalho no boot. Num Worker, o tempo de inicialização do isolate entra na latência do usuário, e a meta era manter esse custo perto de zero.

O grafo de serviços também é cheio de ciclos. O serviço de assinaturas chama o de cobranças, que chama o de assinaturas de volta. Injeção pelo construtor só resolve isso com proxies preguiçosos, que complicam a depuração.

E havia a transação. As rotas de escrita rodam dentro de um middleware que abre uma transação e troca a conexão do contexto por ela. Depois do commit, a conexão volta a ser a do pool, e tarefas que rodam após o commit precisam dela, não da transação já encerrada. Um container que guardasse a conexão errada quebraria uma das duas fases.

## A solução

### Um container por requisição, resolvido na hora

Cada requisição tem um container que guarda as instâncias de serviços e repositórios já construídas. Ninguém constrói nada no boot. Um serviço só nasce quando alguém o pede pela primeira vez naquela requisição, e as próximas chamadas recebem a mesma instância.

Os ciclos se resolvem sozinhos: construir um serviço nunca constrói outro, só chamar um método faz isso, e quando o método roda a instância já existe.

### A chave é o par contexto e conexão

O container é indexado pelo contexto da requisição e pela conexão de banco atual, juntos. As duas metades são necessárias. Só o contexto reaproveitaria, depois do commit, serviços presos à transação encerrada, e a tarefa pós-commit falharia com "transação já concluída". Só a conexão misturaria requisições diferentes na suíte de testes, onde várias requisições compartilham uma transação, e o cache de uma vazaria para a outra.

A conexão é lida do contexto no momento de resolver, nunca capturada antes. Durante o handler, o container resolve sobre a transação. Depois do commit, sobre o pool.

### Campos tipados, gerados de um registro

Para o uso ficar natural, um script gera um registro a partir de todos os arquivos de serviço, ligando cada classe a um nome em camelCase. No boot, esse registro instala um getter preguiçoso por nome no protótipo da classe base dos serviços, e uma fusão de interfaces do TypeScript dá o tipo de cada campo. Dentro de qualquer serviço, basta escrever `this.invoicesService.findById(...)`. Fora deles, controllers, jobs e handlers de webhook usam uma função curta que recebe o contexto e a classe.

Esquecer de regenerar o registro ao criar um serviço quebra o CI num passo próprio, e um teste local aponta qual serviço ficou de fora.

### Regras escritas junto

Duas regras ficaram documentadas. Serviço não guarda estado mutável em campo, porque agora existe uma instância por requisição e fase. E dentro de um savepoint aberto à mão, que não troca a conexão do contexto, não se resolve serviço pelo container: ele entregaria repositórios da transação de fora.

## Um exemplo

O núcleo do container, reduzido a poucas linhas:

```ts
type Db = object; // pool ou transação
type Ctx = { var: { db: Db } };
type Ctor<T> = new (ctx: Ctx) => T;

const byContext = new WeakMap<Ctx, WeakMap<Db, Map<Ctor<unknown>, unknown>>>();

function use<T>(ctx: Ctx, Service: Ctor<T>): T {
  const db = ctx.var.db; // lida agora: acompanha a troca entre transação e pool
  let byDb = byContext.get(ctx);
  if (!byDb) byContext.set(ctx, (byDb = new WeakMap()));
  let instances = byDb.get(db);
  if (!instances) byDb.set(db, (instances = new Map()));
  if (!instances.has(Service)) instances.set(Service, new Service(ctx));
  return instances.get(Service) as T;
}
```

E a linha do tempo de uma requisição de pagamento de fatura:

```text
handler (db = transação T1)
  use(ctx, Charges)  -> constrói Charges sobre T1
  use(ctx, Invoices) -> constrói Invoices sobre T1
  use(ctx, Charges)  -> mesma instância, nenhuma construção
COMMIT, ctx.var.db volta ao pool P
tarefa pós-commit (db = P)
  use(ctx, Notifications) -> constrói sobre P, nunca sobre T1 encerrada
```

O `as T` no exemplo encurta a explicação. No código real, o tipo de cada serviço vem do registro gerado.

## Resultado

Toda a base passou a ter uma forma só de resolver serviços. Os serviços herdam da classe base e chegam aos vizinhos como campos tipados; controllers, jobs, middlewares e handlers de webhook usam a mesma função de resolução, e a suíte de testes também. A migração saiu em etapas: um piloto nos cinco módulos com mais uso, depois o resto. A antiga fábrica virou um atalho fino sobre o container, para não quebrar branches em andamento. O código ficou menor, sem nenhuma dependência nova e sem custo no boot.

## O que eu levo disso

Injeção de dependência é um problema de escopo e de tempo de vida, não de biblioteca. Num ambiente serverless, o escopo natural é a requisição, e o tempo de vida certo inclui a fase do banco em que o código está. Resolver preguiçosamente, na hora do uso, resolveu de uma vez o cold start, os ciclos e a transação.
