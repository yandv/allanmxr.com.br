---
title: "Três gateways, uma assinatura: escolher pelo que o contrato exige"
summary: "Cada gateway de pagamento da plataforma sabia fazer coisas diferentes, e escolher um deles com if espalhado pelo código garantia uma assinatura presa num gateway que não suportava o plano. Fiz o roteamento virar uma função pura sobre uma matriz de capacidades."
project: salte
order: 10
tags: [Billing, Stripe, Woovi, Gateways de pagamento, TypeScript]
---

Uma clínica escolhe o plano anual da Salte, acrescenta um módulo extra cobrado todo mês e paga no cartão. Outra prefere o mensal no Pix, com período de teste. Uma terceira negociou um preço especial com o time comercial. As três passam pela mesma tela de checkout, e cada uma precisa cair num gateway de pagamento que saiba de fato fazer o que ela contratou. Se cair no errado, o problema não aparece no dia: aparece na primeira renovação, quando o gateway não sabe cobrar o módulo extra.

## O problema

O billing da plataforma, que cobra as próprias clínicas pela assinatura da Salte, nasceu falando com três gateways. A Stripe cobra cartão e faz praticamente tudo: módulos recorrentes, proração imediata na troca de plano, pausa, preço sob medida, compra avulsa no cartão guardado. A Woovi cobra assinatura por Pix Automático (o débito recorrente do Pix), inclusive com período de teste, e quase nada além disso. Um terceiro gateway cobra assinatura simples no cartão e faz compra avulsa por página de checkout hospedada.

Cada um tem um conjunto de capacidades, e elas não se sobrepõem de forma limpa. A decisão de "qual gateway atende este contrato" é de negócio, mas tinha tudo para virar um emaranhado de condicionais espalhadas pela criação de assinatura.

## Por que não era trivial

A escolha depende de várias características ao mesmo tempo: meio de pagamento, módulos recorrentes já na assinatura, preço sob medida, troca de plano com proração imediata, compra avulsa, período de teste, pausa e desconto temporário. Qualquer combinação nova pode excluir um gateway.

Além disso, quem opera o negócio precisa mudar a ordem de preferência sem deploy: desligar um gateway para contratos novos sem afetar os antigos, ou priorizar outro por custo. E quando nenhum gateway serve, a resposta precisa dizer por quê, gateway por gateway, senão ninguém sabe se o problema é a configuração ou o plano.

Os gateways também diferem no modelo de cobrança. Na Stripe, é a Salte que decide quando cobrar: um job de ciclo gera a fatura e submete a cobrança. Na Woovi, a recorrência é gerenciada pelo próprio gateway, que cria as cobranças sozinho e avisa por webhook. Esse modo de execução precisa acompanhar a decisão.

## A solução

### O contrato descreve a necessidade

Antes de criar a assinatura, o checkout monta um contrato: meio de pagamento e uma lista de booleanos do que a assinatura exige. Não há nenhuma menção a gateway ali. É a descrição do que precisa acontecer durante a vida daquela assinatura.

### A matriz descreve os gateways

Cada gateway tem uma linha numa matriz de capacidades: sabe ou não sabe cada uma das exigências do contrato. A matriz é um arquivo de código, revisado em pull request, com o motivo de recusa de cada capacidade escrito em texto legível.

### O roteador é uma função pura

O roteamento recebe os candidatos já ordenados por prioridade (vindos da configuração do operador, filtrados pelo meio de pagamento) e o contrato. Ele percorre a lista: pula quem está desligado para contratos novos, confere a matriz e devolve o primeiro compatível, junto com o modo de execução. Se não for o primeiro da lista, a decisão registra por que o primário foi recusado. Se nenhum servir, devolve uma falha com os motivos de cada gateway.

Sem banco, sem rede, sem relógio. Isso tornou o roteamento testável com tabela: cada linha é um contrato e o gateway esperado.

### Adaptadores atrás de uma interface

Cada gateway tem um adaptador com a mesma interface para o resto do billing: criar cliente, criar assinatura, cobrar, estornar, cancelar. A regra de negócio fala com a interface, e o webhook de cada gateway é traduzido para os mesmos eventos internos. Quando a Salte passou a cobrar uma assinatura nova pela Araute, o gateway ganhou adaptador e fluxo de criação próprios, mas a escolha continuou no mesmo roteador: bastou uma linha nova na matriz.

## Um exemplo

Uma matriz simplificada, com valores ilustrativos:

| Capacidade | Stripe | Woovi | Gateway C |
| --- | --- | --- | --- |
| Módulo recorrente na assinatura | sim | não | não |
| Preço sob medida | sim | não | não |
| Proração imediata | sim | não | não |
| Período de teste | sim | sim | não |
| Pausa | sim | não | não |

E o roteador, reduzido ao essencial:

```ts
type Gateway = 'STRIPE' | 'WOOVI' | 'GATEWAY_C';
type Need = 'recurringAddons' | 'customPrice' | 'immediateProration' | 'trial' | 'pause';
type Candidate = { gateway: Gateway; enabledForNew: boolean };

const CAPS: Record<Gateway, Record<Need, boolean>> = {
  STRIPE: { recurringAddons: true, customPrice: true, immediateProration: true, trial: true, pause: true },
  WOOVI: { recurringAddons: false, customPrice: false, immediateProration: false, trial: true, pause: false },
  GATEWAY_C: { recurringAddons: false, customPrice: false, immediateProration: false, trial: false, pause: false },
};

function route(candidates: Candidate[], needs: Need[]) {
  const rejected: { gateway: Gateway; missing: Need[] }[] = [];
  for (const { gateway, enabledForNew } of candidates) {
    const missing = needs.filter((need) => !CAPS[gateway][need]);
    if (enabledForNew && missing.length === 0) return { ok: true, gateway, rejected };
    rejected.push({ gateway, missing });
  }
  return { ok: false, rejected };
}
```

Uma clínica fictícia quer pagar no cartão com um módulo recorrente, e o operador colocou o Gateway C na frente por custo:

```ts
route(
  [{ gateway: 'GATEWAY_C', enabledForNew: true }, { gateway: 'STRIPE', enabledForNew: true }],
  ['recurringAddons'],
);
// { ok: true, gateway: 'STRIPE', rejected: [{ gateway: 'GATEWAY_C', missing: ['recurringAddons'] }] }
```

A mesma clínica, sem o módulo extra, cairia no Gateway C, como o operador quis. E se a Stripe estivesse desligada para contratos novos, a resposta seria uma recusa com os dois motivos, antes de qualquer cobrança.

## Resultado

Adicionar uma exigência nova ao contrato virou três passos: um campo no contrato, uma coluna na matriz, um caso na tabela de testes. O operador muda prioridade e liga ou desliga gateways para contratos novos pela configuração, e as assinaturas existentes continuam no gateway onde nasceram. Nenhuma assinatura nasce num gateway que não consegue renová-la.

Também escrevi testes de fumaça contra os ambientes de teste reais de dois gateways, atrás de uma flag, para conferir que cada adaptador cumpre o contrato da interface com a API de verdade e não só com um mock.

## O que eu levo disso

Quando a pergunta é "quem sabe fazer isto?", a resposta cabe numa tabela, e a decisão cabe numa função pura sobre ela. Separar o que o cliente precisa do que cada fornecedor oferece deixa a regra legível para quem não lê o código e transforma a troca de fornecedor numa mudança de dados.
