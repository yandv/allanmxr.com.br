---
title: Pagar no cartão uma fatura que já tem boleto emitido
summary: "A Stripe não deixa pagar no cartão uma fatura que já tem boleto emitido, e o cliente ficaria esperando o boleto vencer. Criei um fluxo que troca a fatura com segurança, sem risco de cobrar duas vezes se o boleto for pago depois."
project: great-softwares
order: 12
tags: [Stripe, Boleto, Pagamentos, Saga, Idempotência]
---

Imagine um cliente do Great Apps que recebe o boleto da mensalidade, deixa para depois e, no dia do vencimento, decide que prefere pagar no cartão. Ele entra no painel, cadastra o cartão e clica em "pagar fatura". Se o sistema só repassasse o pedido à Stripe, a resposta seria uma mensagem dizendo que existe um boleto pendente. Ele não teria saída: precisaria esperar o boleto vencer e a Stripe mudar o status, o que leva mais tempo que o próprio vencimento. Enquanto isso, a conta poderia cair em atraso.

## O problema

Quando a Stripe emite um boleto, ela cria um PaymentIntent (o objeto que representa a tentativa de cobrança) no estado `requires_action`, esperando o pagamento no banco. Nesse estado, a Stripe recusa todos os atalhos óbvios:

- pagar a fatura com cartão falha, porque o PaymentIntent do boleto não pode ser editado nem cancelado;
- dar baixa por fora é recusado enquanto existir um pagamento aberto;
- anexar um PaymentIntent de cartão à parte cobra o cartão, mas não baixa a fatura.

Os caminhos que o app tinha esbarravam nessa restrição: uma rota trocava a assinatura para cartão sem cobrar nada e devolvia a mensagem de boleto pendente, a outra simplesmente recusava. Nenhuma resolvia o que o cliente queria.

## Por que não era trivial

O boleto emitido continua pagável no banco até vencer, mesmo que eu anule a fatura na Stripe. E boleto não tem estorno pela Stripe. Isso cria uma janela perigosa: se eu cobro o cartão, anulo a fatura e o cliente ainda paga o boleto, ele pagou duas vezes, e a devolução de um dos lados vira um processo manual.

Além disso, qualquer sequência de chamadas pode parar no meio. Worker encerrado, Stripe lenta, webhook atrasado, cartão pedindo 3DS (o desafio extra de autenticação do banco emissor). E a assinatura em si não podia mudar de forma de pagamento por causa disso: o cliente queria pagar este ciclo no cartão, não migrar para sempre.

## A solução

Em vez de forçar a fatura original (vou chamar de A), criei uma fatura B: substituta, avulsa, só no cartão, com as mesmas linhas e os mesmos períodos de A, para a nota fiscal sair na competência certa. B fica ligada à assinatura por metadata, não pelo vínculo nativo. Uma fatura com vínculo nativo arrastaria itens pendentes da assinatura e poderia virar a "última fatura" dela, entrando na régua de cobrança.

### As três regras

1. **Cobrar primeiro, anular depois.** Se o cartão recusar, a dívida do ciclo continua existindo em A, intacta.
2. **Nunca anular sem prova.** Toda decisão sai de um estado relido da Stripe sem cache, nunca da resposta de uma escrita anterior.
3. **Nunca tratar o ciclo como pago antes de A estar confirmadamente anulada.** Até lá, B não existe para o resto do sistema.

### Estados em metadata

B nasce escondida das listagens, da comissão de afiliado, da nota fiscal e das integrações. O estado dela avança numa chave de metadata: `pending` (criada, A ainda não anulada), `settled` (A confirmada anulada e assinatura local reconciliada) e `done` (os efeitos de pagamento rodaram ao menos uma vez). Existe uma saída de emergência, `refunding` e `refunded`, para quando o cartão foi cobrado mas A não pôde ser anulada: eu estorno o cartão e limpo as marcas.

Guardar o estado na própria fatura da Stripe foi deliberado. O reconciliador acha as substitutas pela busca de metadata da Stripe e não depende de uma tabela minha estar sincronizada.

### Uma armadilha de herança

B não recebe as marcas que identificam uma fatura avulsa de ciclo. Essas marcas autorizam um cron de cancelamento por atraso. Se B as herdasse, o sistema poderia cancelar a assinatura por causa de uma fatura que só existe como ponte.

### O reconciliador

Um cron a cada 10 minutos retoma o que ficou pela metade:

- B aberta e `pending` há mais de uma hora (3DS abandonado): anula B;
- B paga e `pending` há mais de 15 minutos: termina o fechamento;
- `refunding` parado: retoma o estorno;
- `settled` que nunca chegou a `done`: reexecuta os efeitos de pagamento, no máximo três vezes, com intervalo mínimo entre elas.

O disparo manual dele começa em modo de simulação, e só executa de verdade em ambiente de teste.

## Um exemplo

O fechamento, depois que B foi paga, em TypeScript com nomes genéricos:

```ts
async function settleReplacement(b: Invoice) {
  const a = await stripe.invoices.retrieve(b.metadata.replaces_invoice); // sem cache
  if (a.status === "open") {
    await stripe.invoices.voidInvoice(a.id);
  }
  // regra 2: decide pelo que a Stripe diz agora, não pelo retorno do void
  const fresh = await stripe.invoices.retrieve(a.id);
  if (fresh.status === "paid") return startRefund(b, "original_paid_first");
  if (fresh.status !== "void") return scheduleRetry(b);

  await reconcileLocalSubscription(b.metadata.subscription);
  await stripe.invoices.update(b.id, {
    metadata: { replacement_state: "settled", skip_in_listing: "" },
  });
}
```

E três desfechos possíveis para o mesmo clique:

| Cenário | Sequência | Resultado |
|---|---|---|
| Caminho feliz | cria B, cobra cartão, relê A aberta, anula A, relê A anulada, revela B | ciclo pago no cartão, boleto ignorado |
| Cartão recusado | cria B, cobrança falha, anula B | A continua aberta com o boleto, nada mudou para o cliente |
| Boleto pago no meio | cria B, cobra cartão, relê A e encontra A paga | B vai para `refunding`, cartão estornado, ciclo pago pelo boleto |

O terceiro cenário é o motivo da regra 2. Se eu confiasse na resposta do comando de anular, poderia marcar o ciclo como pago no cartão enquanto o banco já tinha liquidado o boleto.

## Resultado

O cliente consegue pagar no cartão o ciclo que já tinha boleto, sem trocar a forma de pagamento da assinatura e sem depender de a Stripe liberar o PaymentIntent. As paradas no meio são retomadas pelo reconciliador, e cada estado relevante gera um evento de log próprio.

Antes de escrever o fluxo, medi na Stripe de teste cada comportamento de que ele depende: anular A com boleto vivo, o que chega quando o boleto é pago depois da anulação, como a idempotência responde a duas cobranças simultâneas, quanto tempo a busca por metadata demora para enxergar uma fatura nova. O desenho saiu dessas medições, não de suposições.

Um risco ficou aceito de forma consciente: se o cliente pagar o boleto e o cartão quase ao mesmo tempo, ele fica com as duas cobranças até o reconciliador estornar o cartão, o que leva alguns minutos.

## O que eu levo disso

Quando um sistema externo não deixa desfazer um passo, a saída é modelar a operação com dois objetos e uma ordem estrita: primeiro o passo reversível, por último o irreversível, e nunca avançar sem reler o estado real.

Guardar o estado da saga no próprio objeto externo, em metadata, deixa a retomada simples. O cron não precisa confiar numa cópia local. E medir a API antes de desenhar em cima dela poupa semanas de correção.
