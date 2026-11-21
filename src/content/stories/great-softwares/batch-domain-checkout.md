---
title: Uma cobrança só para um carrinho com vários domínios
summary: "Com uma cobrança por domínio, quem compra cinco domínios teria cinco QR codes de Pix com prazo curto para pagar em sequência. Criei uma cobrança única por carrinho, e quando um domínio falha só ele é estornado."
project: great-softwares
order: 17
tags: [Idempotência, Pix, PostgreSQL, Estorno, API REST]
---

Imagine uma agência que monta o carrinho com o domínio do cliente em `.com.br`, a versão `.com` e mais três variações para proteger a marca, e clica em pagar. Com a regra de um pedido por cobrança, a tela responderia com cinco QR codes de Pix, um por domínio, cada um com seu prazo de cinco minutos. Ninguém paga cinco Pix seguidos com calma. Parte deles expiraria no meio do caminho, e o carrinho terminaria pela metade.

## O problema

O Great Domains nasceu com uma regra simples: um pedido, uma cobrança, um domínio. Isso funciona bem para quem compra um domínio por vez. Para quem compra cinco, vira cinco cobranças independentes, cinco chances de expirar e cinco linhas na fatura do cartão.

Eu precisava de uma cobrança só para o carrinho inteiro. O cliente paga uma vez, vê um QR code só, e cada domínio segue o seu caminho depois disso.

## Por que não era trivial

Uma cobrança paga vários pedidos, mas cada pedido tem vida própria depois do pagamento. Um domínio registra, outro falha porque alguém registrou antes, um terceiro expira porque o Pix chegou atrasado. Então o lote precisa ser **tudo ou nada na criação** e **item por item na liquidação**. São duas regras opostas no mesmo fluxo.

Havia mais três pontos:

- **Reenvio.** Rede móvel ruim e clique duplo fazem o cliente mandar a mesma requisição duas vezes. Duas cobranças para o mesmo carrinho é o pior bug possível num checkout.
- **Preço congelado.** O cliente vê um total na tela. Se o preço de um TLD (a terminação, como `.com` ou `.io`) muda entre a cotação e o clique, cobrar o valor novo sem avisar é errado.
- **Chamada externa no meio.** A cobrança é criada no sistema de pagamentos da plataforma, fora do meu banco. Se eu crio a cobrança e depois falho ao gravar os pedidos, fica um Pix pago sem pedido nenhum.

## A solução

### Primeiro tudo local, depois a chamada externa

A criação acontece em duas fases. Na primeira, eu valido e preço cada item pelo mesmo caminho do pedido unitário, sem reescrever regra nenhuma. Depois comparo a soma com o total que o cliente viu na tela. Se divergir, respondo `409` e peço para ele recotar. Também confiro que as linhas da fatura somam exatamente o total, já com o desconto do cupom distribuído entre registro e privacidade.

Só então abro uma transação no PostgreSQL e gravo tudo junto: uma linha de pagamento com o total congelado e um pedido por domínio, cada um com os dados do titular congelados. Se qualquer item falha, a transação reverte e nenhuma chamada externa acontece. A mensagem de erro aponta qual domínio do carrinho causou o problema.

Na segunda fase, com os pedidos já gravados, crio a cobrança avulsa com uma linha por domínio e uma por privacidade WHOIS. Se a cobrança é recusada de forma definitiva, eu apago os pedidos do lote e libero a chave. Se é só uma instabilidade, os pedidos ficam esperando e a próxima tentativa retoma de onde parou.

### Idempotência em dois níveis

A rota de lote exige o cabeçalho `Idempotency-Key`. Um middleware calcula o hash do corpo em JSON canônico (chaves ordenadas) e guarda a resposta. Repetiu a chave com o mesmo corpo, ele devolve a resposta gravada com um cabeçalho dizendo que é replay. Repetiu a chave com corpo diferente, é `409`.

O caso de uso tem uma segunda camada. Se a primeira fase terminou mas a segunda caiu, a chave aponta para um pagamento já gravado. Nesse caso eu confiro se os domínios e os prazos são os mesmos e retomo a cobrança. E a própria chamada ao sistema de pagamentos leva o id do pagamento como chave de idempotência, então nem a retomada cria uma segunda cobrança.

### Liquidação por reconciliação

Quando o Pix é pago, a notificação não liquida nada sozinha. Ela só registra o evento e agenda a reconciliação da conta. A reconciliação lê a cobrança de novo e decide pedido por pedido:

- pendente vira pago, e o provisionamento começa;
- expirado com o domínio ainda livre reabre e segue;
- expirado com o domínio já tomado por outro pedido recebe estorno só da sua parte;
- cancelado mas pago numa corrida também recebe estorno parcial;
- se o total pago difere do total congelado, faço um único estorno do valor pago e todos os pedidos do lote falham como preço fora de sincronia.

Cada estorno parcial usa o id do pedido como chave de estorno. A varredura diária pode passar pelo mesmo pedido de novo sem devolver o dinheiro duas vezes.

A expiração também enxerga o lote. Antes de expirar um pedido, eu tento cancelar a cobrança. Se o cancelamento revela que ela já foi paga, não expiro nada e deixo a reconciliação resolver.

## Um exemplo

Um carrinho com três domínios, Pix, total de R$ 139,70. O cliente está no 4G e o primeiro envio demora.

| Tempo | Evento | O que o sistema faz |
| --- | --- | --- |
| t=0 | `POST` do lote com a chave `k-7f3a` | Valida os três itens, grava pagamento e pedidos numa transação |
| t=180ms | Cobrança criada com três linhas | Devolve o QR code único |
| t=900ms | O app reenvia a mesma requisição | O middleware acha a chave com o mesmo hash e devolve a resposta gravada |
| t=2min | Cliente paga o Pix | A notificação só agenda a reconciliação |
| t=2min05s | Reconciliação roda | Os três pedidos viram pagos e começam a provisionar |
| t=3min | Um dos domínios falha no registrador | Estorno de R$ 39,90 só desse pedido, com o id dele como chave |
| t=24h | Varredura diária passa de novo | Mesma chave de estorno, nada é devolvido duas vezes |

A regra de "tudo local primeiro" cabe em poucas linhas:

```ts
async function createBatch(input: BatchInput) {
  const priced = await Promise.all(input.items.map(priceItem));
  const total = priced.reduce((sum, item) => sum + item.totalCents, 0);
  if (total !== input.expectedTotalCents) throw new QuoteOutdatedError();

  // Nothing external happens until every order exists in the database.
  const { payment, orders } = await db.transaction(async (tx) => {
    const payment = await tx.payments.insert({ totalCents: total, requestKey: input.key });
    const orders = [];
    for (const item of priced) orders.push(await tx.orders.insert({ ...item, paymentId: payment.id }));
    return { payment, orders };
  });

  return billing.createCharge({ idempotencyKey: payment.id, lines: toLines(orders) });
}
```

## Resultado

O cliente paga uma vez e vê um QR code só, seja qual for o tamanho do carrinho. Reenvio de requisição não duplica cobrança. Divergência de preço vira uma resposta clara antes do pagamento, ou um estorno automático depois dele. E um domínio que falha não arrasta os outros: só aquele pedido é devolvido.

## O que eu levo disso

Em lote, separo duas perguntas. A criação precisa ser atômica, então tudo que é local vai numa transação antes de qualquer chamada externa. A liquidação precisa ser granular, então cada item é decidido sozinho por uma reconciliação que pode rodar quantas vezes quiser. E todo efeito com dinheiro ganha uma chave determinística, porque a pergunta nunca é se a operação vai ser repetida, e sim quando.
