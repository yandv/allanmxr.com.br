---
title: "Estornar ou seguir em frente: o pedido de domínio que falha no meio"
summary: "Entre o pagamento e o domínio registrado qualquer passo pode falhar, e a mesma falha pede estorno ou continuação conforme o momento. Fiz todo pedido terminar num estado explicável, sem cobrar por domínio não entregue."
project: great-softwares
order: 16
tags: [Máquina de estados, Cloudflare Workflows, PostgreSQL, Idempotência, Estorno]
---

Um cliente do Great Domains escolhe `minhaloja.com.br`, paga com cartão e fecha a aba. Do lado de cá, uma sequência começa: confirmar o pagamento, criar a zona de DNS, registrar o domínio no registrador, esperar a confirmação que o registrador manda depois, avisar o cliente. Agora imagine que o worker morre logo depois de mandar o pedido de registro, antes de gravar a resposta. O domínio foi registrado ou não? O dinheiro deve voltar ou não? Eu precisava que cada pedido terminasse sempre num estado que dá para explicar, mesmo quando um passo falha no pior momento.

## O problema

Comprar um domínio é uma transação distribuída sem transação. O dinheiro passa por um meio de pagamento, a zona de DNS fica na Cloudflare, o registro acontece num registrador externo (Registro.br para `.br`, OpenSRS para os genéricos), e parte das confirmações chega de forma assíncrona. Nenhum desses sistemas participa de um commit comum.

Qualquer passo pode falhar, demorar, ou ser executado duas vezes. E o cliente já pagou.

## Por que não era trivial

**A mesma falha tem significados opostos.** Se o registro falha antes de o domínio existir no registrador, o certo é estornar. Se falha depois de o domínio existir, estornar é devolver o dinheiro de uma compra que entregou o produto. Tratar as duas do mesmo jeito é um bug de dinheiro nas duas direções.

**Pagamento chega atrasado.** Um 3DS (a autenticação extra do cartão) confirmado depois de o pedido expirar, ou um Pix pago no último segundo. O pedido já estava como expirado e precisa voltar à vida.

**O mesmo domínio não pode ter dois donos.** Duas contas podem tentar comprar o mesmo nome ao mesmo tempo, e só uma pode levar.

**Processos morrem.** Um Workflow pode travar ou sumir no meio do caminho, e ninguém vai perceber se não houver alguém olhando.

## A solução

### Estados e arestas explícitas

O pedido tem nove estados: `PENDING_PAYMENT`, `PAID`, `PROVISIONING`, `PENDING_REGISTRY`, `REGISTERED`, e os desvios `EXPIRED`, `CANCELLED`, `FAILED`, `REFUNDED`. Uma tabela em código lista quais transições são permitidas. `REGISTERED`, `CANCELLED` e `REFUNDED` não têm saída: são terminais. `FAILED` só sai para `REFUNDED`. `EXPIRED` só sai para `PAID`.

Toda mudança de estado passa por uma única função, que valida a aresta contra a tabela e depois executa um `UPDATE` condicional: só muda se o status atual ainda é um dos esperados. É um compare-and-swap no banco. Se a função devolve vazio, outra execução chegou antes, e quem chamou trata isso como "já foi feito", não como erro.

### Pagamento tardio só reabre se o domínio continua livre

`EXPIRED` pode voltar a `PAID` dentro de uma janela de 72 horas. A garantia de dono único é dupla: uma consulta que procura outro pedido vivo para o mesmo domínio, de qualquer conta, e um índice único parcial no banco que só permite um pedido em estado vivo por domínio. Se o nome já foi tomado, o pagamento tardio vira estorno.

### Provisionamento como Workflow durável

O provisionamento roda num Cloudflare Workflow, um mecanismo de execução durável em que cada passo concluído fica salvo e uma retomada pula os passos já feitos. O primeiro passo faz o CAS de `PAID` para `PROVISIONING`. Depois vêm zona de DNS, registro e conclusão.

O passo de registro é idempotente: antes de registrar, ele pergunta ao registrador se o domínio já está na conta. E uma regra fixa: erro de infraestrutura depois do registro nunca dispara estorno. Ele só registra o problema e deixa o pedido para a recuperação.

### Recuperação por varredura

A cada 15 minutos, um cron lista pedidos em `PAID`, `PROVISIONING` e `PENDING_REGISTRY`, consulta a saúde da instância do Workflow de cada um (viva, morta ou desaparecida) e pergunta ao registrador se o domínio existe. Com esses três dados, uma função pura decide o que fazer.

### Estorno como primitiva idempotente

O estorno lê o estado do pagamento, cancela o que precisa e trata "já estornado" como sucesso. Outro cron relista pedidos com estorno pendente ou falho e tenta de novo, sem depender do Workflow que originou a falha. Erro num pedido não interrompe a varredura dos outros.

## Um exemplo

A decisão de recuperação cabe numa função pura, sem banco nem rede, o que a torna trivial de testar com uma tabela de casos:

```ts
type Health = "alive" | "dead" | "missing";
type Action = "skip" | "restartFromStart" | "restartFromRegister" | "failAndRefund" | "manual";

const RESTART_WINDOW_MS = 72 * 60 * 60 * 1000;

function decideRecovery(
  order: { status: string; paidAt: Date | null },
  health: Health,
  existsAtRegistrar: boolean | null, // null = o registrador não respondeu
  now: Date,
): Action {
  if (health === "alive") return "skip";

  if (order.status === "PAID") return health === "dead" ? "restartFromStart" : "skip";

  // Só a ausência confirmada do domínio dá direito a estorno automático.
  if (existsAtRegistrar === false) return "failAndRefund";
  if (existsAtRegistrar === null || health === "missing") return "manual";

  const withinWindow = order.paidAt !== null && now.getTime() - order.paidAt.getTime() <= RESTART_WINDOW_MS;
  return withinWindow ? "restartFromRegister" : "manual";
}
```

Voltando à cena do começo, com horários fictícios:

| Hora | Evento | Estado |
| --- | --- | --- |
| 14:00:00 | Pagamento confirmado | `PAID` |
| 14:00:02 | Workflow faz o CAS e cria a zona de DNS | `PROVISIONING` |
| 14:00:05 | Pedido de registro enviado; o worker morre antes de gravar a resposta | `PROVISIONING` |
| 14:15:00 | Cron vê instância morta; registrador diz que o domínio existe | `restartFromRegister` |
| 14:15:01 | Workflow retoma, pula DNS (já salvo), registro detecta que já existe | `REGISTERED` |

O cliente recebe o domínio 15 minutos depois, sem cobrança dupla e sem estorno indevido. Se o registrador tivesse respondido que o domínio não existe, o mesmo cron levaria o pedido a `FAILED` e depois a `REFUNDED`. Se o registrador não respondesse, o pedido iria para decisão manual, com um log que vira alerta.

## Resultado

Todo pedido termina num estado terminal que dá para explicar: registrado, cancelado ou estornado. Falha parcial não deixa pedido preso nem dinheiro cobrado sem entrega. Dois processos concorrentes nunca aplicam a mesma transição duas vezes, porque o banco recusa o segundo CAS. E a parte mais delicada, decidir entre retomar e estornar, é uma função pura coberta por testes de tabela.

## O que eu levo disso

Separe "falha antes do ponto sem retorno" de "falha depois". Só a primeira dá direito a compensação automática. A segunda se resolve andando para frente, com passos idempotentes que podem ser repetidos sem medo. Quando não dá para saber de que lado da linha você está, a resposta certa é parar e chamar uma pessoa, não chutar.
