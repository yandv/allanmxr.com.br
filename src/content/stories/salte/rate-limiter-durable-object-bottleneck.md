---
title: "Rate limiting em Workers: Durable Object só onde a precisão global importa"
summary: "O primeiro desenho do limitador de requisições contava tudo em Durable Objects, pela exatidão. Uma medição de carga mostrou o preço: cerca de 330 ms por requisição e fila nas chamadas paralelas. Separei os limites que precisam de precisão global dos que não precisam, e o piso foi para 45 ms."
project: salte
order: 15
tags: [Cloudflare Workers, Durable Objects, Rate limiting, Performance, Hono]
---

Uma tela do ERP, como a agenda da clínica, dispara várias chamadas à API ao mesmo tempo: profissionais, salas, horários, agendamentos. Todas leves, várias já em cache. Antes de qualquer uma delas chegar ao handler, passa pelo limitador de requisições, que protege a API contra abuso. O limitador é infraestrutura que ninguém vê, e por isso mesmo eu queria saber quanto ele custava em cada requisição.

## O problema

O primeiro desenho do limitador rodava inteiro sobre Durable Objects. Um Durable Object é um objeto com identidade única no mundo inteiro: para cada nome existe uma só instância, e ela processa as chamadas uma de cada vez. É exatamente o que se quer para contar tentativas de login com precisão, e foi por isso que ele nasceu assim: a mesma garantia para todos os limites.

Numa rodada de medição de carga no ambiente de desenvolvimento, apareceu o preço dessa garantia. Uma requisição que parava antes do limitador, um 401 por falta de sessão, respondia em 20 ms. Uma requisição autenticada com tudo em cache levava 335 ms. Dez chamadas simultâneas à mesma rota respondiam em 324, 652, 998 ms, e assim por diante até 3483 ms: um degrau quase fixo de 330 ms por chamada. Isso é o desenho de uma fila.

A causa era a chave do limite global de cada rota, que mapeava para um único objeto da plataforma inteira. Toda requisição àquela rota, de qualquer clínica, passava por ele em fila.

## Por que não era trivial

A saída óbvia seria trocar tudo pelo limitador nativo da Cloudflare, uma ligação (binding) de rate limiting que conta localmente em cada data center, sem ida a um objeto central. Ele é rápido, mas aproximado: cada local conta o seu, e o total global não é exato.

Para a maioria das rotas, isso não importa. Ninguém precisa de exatidão global para limitar a leitura da agenda. Mas há limites em que a precisão é a razão de existir: tentativas de login e de MFA, PIN de transação, saída de dinheiro da conta da clínica, estornos, repasses, webhooks. Neles, um atacante distribuindo tentativas entre data centers não pode ganhar tentativas extras.

Além disso, o limitador tinha comportamentos que o binding nativo não oferece: janela que escala a cada abuso, atraso progressivo e devolução da tentativa quando a requisição falha na validação. Qualquer limite que dependesse disso tinha de continuar no objeto.

## A solução

### Uma regra para decidir quem sai do objeto

Cada configuração de limite é classificada. Ela continua no Durable Object se escala a janela, aplica atraso, precisa devolver a tentativa em erro de validação ou está marcada como estrita. Todo o resto vai para o binding nativo, contado por data center.

A marcação de estrita é explícita e revisada: login, MFA, PIN de transação, saída de dinheiro, estornos, repasses e webhooks. Esses limites trocaram velocidade por exatidão de propósito.

### Paralelo onde o objeto fica

Nos limites que continuaram no objeto, uma mesma requisição costumava conferir várias chaves (a global da rota e as escopadas) uma depois da outra. Passei a conferir as chaves em paralelo. A latência virou a da chave mais lenta, não a soma.

### Uma lista só, presa por teste

Os limites do binding nativo precisam ser declarados também na configuração do Worker. Para as duas listas não divergirem, ela é declarada uma vez no código, o tipo do binding deriva dela, e um teste de paridade confere a configuração dos dois ambientes contra essa lista. Esquecer um limite falha no CI, não em produção.

## Um exemplo

A classificação, em forma resumida:

```ts
type LimitConfig = {
  name: string;
  escalatesWindow?: boolean;
  delayMs?: number;
  refundOnValidationError?: boolean;
  strict?: boolean;
};

function backendFor(config: LimitConfig): 'durable-object' | 'native-binding' {
  const needsGlobalAccuracy =
    config.strict || config.escalatesWindow || config.delayMs !== undefined || config.refundOnValidationError;
  return needsGlobalAccuracy ? 'durable-object' : 'native-binding';
}

backendFor({ name: 'login', escalatesWindow: true, strict: true }); // 'durable-object'
backendFor({ name: 'pix-out', strict: true }); // 'durable-object'
backendFor({ name: 'list-appointments' }); // 'native-binding'
```

E as medições do primeiro desenho e do desenho final, no mesmo ambiente:

| Cenário | Primeiro desenho | Desenho final |
| --- | --- | --- |
| Requisição autenticada com cache quente | 335 ms | 45 ms |
| Dez chamadas simultâneas à mesma rota, a mais lenta | 3483 ms | 566 ms |
| Crescimento por chamada simultânea | cerca de 330 ms | sem degrau fixo |

Dez chamadas paralelas à mesma rota trocaram uma fila de três segundos e meio por pouco mais de meio segundo.

## Resultado

O piso de toda requisição autenticada foi de 335 ms para 45 ms, e chamadas simultâneas à mesma rota não fazem mais fila. Os limites que protegem login, MFA, PIN e dinheiro continuam exatos, no Durable Object, sem pagar pela fila dos outros.

## O que eu levo disso

Um Durable Object é uma fila com nome. Isso é uma virtude quando a fila é o que se quer, como contar tentativas de senha, e um gargalo quando a chave junta o tráfego de todo mundo num só lugar. Antes de otimizar o banco ou o cache, vale medir o que roda antes do handler: o custo fixo de cada requisição costuma morar no middleware que ninguém lembra que existe.
