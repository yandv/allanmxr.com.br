---
title: "Uma camada de cache sobre a Cache API: leitura quente sem perder o tipo"
summary: "Desenhei a camada de cache da API sobre a Cache API da Cloudflare, com chaves versionadas e renovação em segundo plano. Ao exercitar o billing, apareceu o limite de guardar objetos em JSON: datas voltavam como texto. A versão final preserva o tipo na ida e na volta."
project: salte
order: 13
tags: [Cache, Cloudflare Workers, TypeScript, JSON, Stale-while-revalidate]
---

A dona de uma clínica abre o ERP e a primeira tela pede quem ela é, de quais clínicas participa, que permissões tem em cada uma e em que pé está a assinatura. São leituras pequenas, repetidas em quase toda requisição, e cada uma custa uma ida ao Postgres. Num Worker, onde cada milissegundo antes do handler conta, essas leituras pediam um cache. A pergunta era como fazer um cache que respondesse rápido, nunca servisse dado de um ambiente em outro e devolvesse exatamente o que o banco devolveria.

## O problema

A API roda em Cloudflare Workers, e a forma nativa de guardar respostas perto do usuário é a Cache API, que armazena objetos `Response` por URL em cada data center. Ela não sabe nada de objetos de domínio: guarda bytes e devolve bytes. Para usá-la como cache de aplicação, eu precisava de uma camada que transformasse "o usuário 42 desta clínica" numa chave, cuidasse de expiração e escondesse a serialização do resto do código.

Três exigências guiaram o desenho: chaves que nunca colidissem entre serviços e ambientes; uma leitura quente que não fizesse o usuário esperar a renovação do valor; e um contrato de tipos honesto, em que o dado lido do cache tivesse a mesma forma do dado lido do banco.

## Por que não era trivial

A Cache API não tem expiração por item que a aplicação consiga consultar, nem invalidação em massa. Mudar o formato de uma entrada exige um jeito de abandonar as antigas sem apagá-las uma a uma.

Renovar em segundo plano também tem um detalhe de plataforma. Num Worker, trabalho que continua depois da resposta precisa ser registrado com `waitUntil`, senão o runtime pode encerrá-lo no meio.

E JSON não tem tipo de data. `JSON.stringify` transforma um `Date` em texto ISO, e a leitura devolve texto. Para piorar, o TypeScript não percebe: a função que lê do cache declara o tipo de retorno, e o compilador acredita.

## A solução

### Chaves como URLs num espaço próprio

Cada instância do cache é identificada por serviço, ambiente e versão, e a chave de cada entrada vira uma URL interna num domínio que só serve de namespace. Produção, staging e desenvolvimento convivem no mesmo Worker sem colidir. Subir a versão abandona todas as entradas antigas de uma vez, sem apagar nada: elas simplesmente deixam de ser procuradas.

Cada entrada guarda o valor, o instante de expiração e o TTL efetivo, limitado entre um segundo e sete dias, com cinco minutos como padrão.

### Sempre quente

A leitura principal recebe uma chave e uma função que busca no banco. Com o modo "sempre quente" ligado, quando mais da metade do TTL passou, o valor em cache volta na hora e uma renovação roda em segundo plano, registrada com `waitUntil`, para a próxima requisição encontrar a entrada fresca. No cache vazio, a escrita também vai para segundo plano: a resposta sai assim que o banco responde. É o padrão stale-while-revalidate, aplicado a objetos de domínio. Gravações invalidam as chaves que afetam, como as sessões do usuário no login, na renovação e no logout.

### O limite encontrado: datas que viravam texto

A primeira versão serializava com `JSON.stringify` e lia com `response.json()`. Ao exercitar a recuperação de pagamento depois do 3D Secure, o avanço de ciclo da assinatura recebeu uma fatura vinda do cache, e a data de fim do período era uma string. Lida do banco, era um `Date`. O resultado dependia de a leitura cair no cache ou não, o pior tipo de comportamento para depurar.

Resolvi em duas camadas. No billing, a conversão de datas passou a aceitar também um valor tipado como `Date` que é string em tempo de execução, e as funções de avanço de ciclo convertem a data de fronteira na entrada. Na camada de cache, que é a causa, fiz o tipo sobreviver à viagem.

### Um envelope para cada Date

Na gravação, um replacer troca cada `Date` por um envelope com uma etiqueta de tipo e o valor ISO. Há uma pegadinha: o `JSON.stringify` chama o `toJSON` da data antes de entregar o valor ao replacer, então o replacer lê o original em `this[key]`. Na leitura, um reviver reconhece o envelope e reconstrói o `Date`. Corpo corrompido ou em formato inesperado conta como cache vazio, nunca como erro. E subi a versão padrão das chaves, para o formato antigo ser abandonado em vez de lido pelo novo.

O dublê de cache da suíte de testes também passou a guardar o corpo como texto, exatamente como a Cache API entrega. Um dublê que guardasse o objeto pronto esconderia justamente a perda de tipo.

## Um exemplo

A perda de tipo, reduzida:

```ts
const invoice = { id: 'inv_1', periodEndsAt: new Date('2026-06-30T23:59:59Z') };
const naive = JSON.parse(JSON.stringify(invoice));
typeof naive.periodEndsAt; // 'string': getTime() não existe aqui
```

O envelope:

```ts
type DateEnvelope = { __t: 'Date'; v: string };

function replacer(this: Record<string, unknown>, key: string, value: unknown) {
  // toJSON já rodou: `value` é string, o Date original continua em this[key]
  const raw = this[key];
  return raw instanceof Date ? { __t: 'Date', v: raw.toISOString() } : value;
}

function reviver(_key: string, value: unknown) {
  const isEnvelope =
    typeof value === 'object' && value !== null && '__t' in value && value.__t === 'Date' && 'v' in value;
  return isEnvelope ? new Date((value as DateEnvelope).v) : value;
}

const roundTrip = JSON.parse(JSON.stringify(invoice, replacer), reviver);
roundTrip.periodEndsAt instanceof Date; // true
```

O cast para `DateEnvelope` encurta o exemplo. No código de verdade, uma função de checagem de tipo confere também que `v` é string.

E a linha do tempo de uma leitura quente, com TTL de 60 segundos:

```text
t=0 s    cache vazio: busca no banco, responde, grava em segundo plano
t=20 s   cache com 1/3 do TTL gasto: responde do cache
t=40 s   mais da metade gasta: responde do cache e renova em segundo plano
t=41 s   renovação grava o valor novo, com expiração em t=101 s
```

## Resultado

As leituras repetidas do ERP, como conta, sessões, permissões e assinatura, respondem do cache sem esperar renovação, e ambientes diferentes nunca compartilham entradas. Leitura do banco e leitura do cache devolvem o mesmo tipo, e qualquer módulo que guarda datas ganhou isso sem mudar uma linha. A suíte reproduz o comportamento real da Cache API, com testes da ida e volta de datas, de corpo corrompido e de formato antigo.

## O que eu levo disso

Cache é uma fronteira de serialização, e toda fronteira de serialização perde tipo, a menos que alguém decida o contrário. Versionar as chaves desde o primeiro dia foi o que tornou barato mudar o formato depois. E um dublê de teste mais "esperto" que a dependência real esconde exatamente os limites que o teste deveria mostrar.
