---
title: Cobrança recorrente no cartão quando o banco exige 3D Secure
summary: "Na renovação automática, sem o cliente na tela, o banco pode exigir autenticação do portador, e isso não é uma recusa: nenhuma retentativa resolve. Desenhei um estado próprio para esse caso, um aviso para a clínica e uma tela que conclui o 3D Secure."
project: salte
order: 11
tags: [Stripe, 3D Secure, Billing, Assinaturas, TanStack Start]
---

É dia de renovação de uma clínica no plano mensal. Às três da manhã, o job de cobrança tenta o cartão guardado, e o banco responde que precisa de uma confirmação do portador no app. A dona da clínica está dormindo. Ela tem cartão válido e quer pagar; só falta ela apertar um botão. Quando eu fechava o desenho da régua de cobrança da plataforma, esse era o caso que separava um billing que insiste às cegas de um que sabe pedir ajuda à pessoa certa.

## O problema

3D Secure é a etapa em que o banco emissor pede ao portador uma confirmação extra, no app ou por código. Em compras com a pessoa presente, a tela de checkout resolve na hora. Na cobrança recorrente, feita sem o cliente na tela (o que os gateways chamam de off-session), o banco ainda pode exigir essa confirmação. Na Stripe, isso volta como `authentication_required`.

A primeira versão da régua tinha dois caminhos para uma cobrança: sucesso ou falha, e falha ia para retentativas sem o cliente presente. Ao rodar os testes de fumaça contra o ambiente de teste da Stripe, com o cartão de teste que exige autenticação, ficou claro que esse terceiro resultado não cabia em nenhum dos dois. Um pedido de autenticação nunca passa sem o cliente: tratado como falha, cada retentativa voltaria igual até a régua chegar ao cancelamento.

## Por que não era trivial

Distinguir o caso é só o começo. Uma vez distinguido, a autenticação precisa acontecer no navegador, com o `client_secret` da intenção de pagamento, um segredo de vida curta que permite concluir aquele pagamento. Ele não pode ficar guardado no banco de dados, e o webhook que avisa do problema não o traz.

Depois, a Stripe tem um comportamento pouco documentado nesse cenário. Quando a cobrança off-session falha por autenticação, a intenção de pagamento volta ao estado "precisa de meio de pagamento" e o cartão sai dela: ele sobrevive só dentro do último erro. Chamar a confirmação do 3D Secure sem reenviar o cartão falha com "meio de pagamento incompatível".

Por fim, uma cobrança esperando autenticação continua viva. Se a dona da clínica, em vez de autenticar, preferir pagar a fatura com outro cartão, a regra de uma tentativa viva por fatura bloquearia o pagamento novo. E cancelar a tentativa antiga não pode abrir a chance de o cliente pagar duas vezes.

## A solução

### Um estado próprio para "precisa do cliente"

O adaptador da Stripe mapeia `authentication_required`, quando ainda há uma intenção de pagamento viva, para um estado de cobrança próprio: requer ação. Recusa comum continua no caminho de sempre. A régua de retentativas só reenvia cobranças falhas, então nunca insiste às cegas numa cobrança que espera o cliente.

A assinatura ainda entra em atraso, de propósito. Assim o prazo de carência corre: se a clínica nunca autenticar, a escalada normal até o cancelamento continua valendo. A diferença é que ela é avisada.

### Avisar uma vez, buscar o segredo na hora

Os efeitos colaterais disparam só na transição para "requer ação": e-mail com link para autenticar, notificação no sino do app e registro de auditoria. Um webhook reentregue para uma cobrança que já está nesse estado atualiza os dados da próxima ação, mas não manda outro e-mail.

Para concluir, o front chama uma rota autenticada que lista as cobranças pendentes da clínica. Para cada uma, a API busca na Stripe, naquele momento, o `client_secret` e o cartão. Nada disso fica gravado. A rota exige uma permissão nova de ver o financeiro da assinatura, porque nem todo membro da clínica deve ver cobranças.

### Reenviar o cartão que a Stripe descolou

Toda resposta que leva ao 3D Secure (no cadastro, na lista de pendências, na fatura e na compra avulsa) traz, junto com o segredo, o identificador do cartão, lido da intenção de pagamento ou do último erro dela. O front reenvia o cartão na confirmação. No front web, fiz uma página de 3D Secure renderizada no servidor, para onde o e-mail aponta, e o pagamento com autenticação direto do recibo da fatura.

### Pagar com outro cartão sem pagar duas vezes

Ao pagar uma fatura manualmente com cartão, a API substitui a cobrança que espera autenticação antes de cobrar o cartão escolhido: cancela na Stripe a intenção de pagamento não capturada, que a partir daí nunca mais pode ser capturada, e marca a cobrança local como cancelada. Uma cobrança que está sendo processada naquele instante não é tocada.

## Um exemplo

A linha do tempo de uma renovação fictícia de R$ 349,00:

```text
dia 10, 03:00  job de ciclo gera a fatura e cobra o cartão sem o cliente
dia 10, 03:00  Stripe: authentication_required
               cobrança "requer ação", assinatura em atraso, nenhuma retentativa
dia 10, 03:01  e-mail "confirme seu pagamento" e notificação no app
dia 10, 09:15  dona abre o link, a página pede as pendências à API
dia 10, 09:15  API busca na Stripe o segredo e o cartão, devolve sem gravar
dia 10, 09:16  front confirma com o segredo e o cartão, banco pede o app
dia 10, 09:17  webhook de sucesso: fatura paga, assinatura volta a ativa
```

O ponto central da classificação, simplificado:

```ts
type Outcome = 'SUCCEEDED' | 'FAILED' | 'REQUIRES_ACTION';

function classifyOffSessionError(code: string | undefined, intentStillUsable: boolean): Outcome {
  // um pedido de autenticação nunca passa sem o cliente: retentar só adia o cancelamento
  if (code === 'authentication_required' && intentStillUsable) return 'REQUIRES_ACTION';
  return 'FAILED';
}

function cardToResupply(intent: { payment_method?: string; last_payment_error?: { payment_method?: string } }) {
  // depois da falha off-session, o cartão só existe dentro do último erro
  return intent.payment_method ?? intent.last_payment_error?.payment_method ?? null;
}
```

Se às 09:15 a dona tivesse preferido pagar com outro cartão, a intenção pendente seria cancelada primeiro, e a fatura receberia uma única cobrança.

## Resultado

Uma renovação que pede autenticação não vira um cancelamento silencioso. A clínica recebe o aviso, conclui o 3D Secure em uma tela feita para isso e volta a ficar ativa no mesmo webhook que confirma o pagamento. Os testes de ponta a ponta cobrem a autenticação exigida indo para "requer ação", a recusa comum ficando na régua, a régua nunca reenviando cobrança que espera o cliente, a permissão da rota e a corrida com a conciliação. Um teste de fumaça contra o ambiente de teste da Stripe, com o cartão de teste que exige autenticação, confere o comportamento da API real e não só o de um mock.

## O que eu levo disso

"Falhou" é uma palavra larga demais para pagamento. Recusa, falta de saldo e pedido de autenticação pedem reações opostas: insistir, esperar, ou chamar o cliente. Quando a reação certa depende de uma pessoa, o sistema tem que transformar o erro num pedido claro para ela, em vez de tentar resolver sozinho até desistir.
