---
title: Quando o corpus não responde, uma pesquisa assíncrona com teto de gasto
summary: "Perguntas fora dos protocolos clínicos terminavam em abstenção, deixando o profissional sem caminho. Fiz o sistema abrir uma pesquisa em literatura aberta em segundo plano, com teto de gasto e as mesmas regras de citação."
project: salte
order: 20
tags: [Cloudflare Workflows, LLM, RAG, Idempotência, Custo de IA]
---

Um profissional de saúde pergunta ao motor clínico sobre uma conduta que os protocolos oficiais do SUS não cobrem. O motor faz o certo: diz que não tem fonte e não responde. Só que "não sei" sozinho deixa a pessoa na mão. Eu queria que, nesses casos, o sistema dissesse "não tenho isso no corpus, mas abri uma pesquisa em artigos abertos e te aviso quando terminar", sem travar o chat e sem afrouxar nenhuma regra de citação.

## O problema

O motor responde com base num corpus fechado de protocolos clínicos e bulas. Quando a pergunta fica fora dele, a abstenção é a resposta correta. Mas existe uma faixa de perguntas em que a literatura científica aberta tem algo a dizer: diretrizes de sociedades médicas, revisões sistemáticas, consensos publicados com licença aberta.

A segunda tentativa precisava de três garantias. Não podia bloquear a conversa. Não podia gastar sem limite com modelo de linguagem. E precisava passar pelo mesmo contrato de resposta do caminho rápido, porque uma resposta vinda de artigo não pode ter regras mais frouxas que uma vinda de protocolo.

## Por que não era trivial

Pesquisar literatura leva dezenas de segundos: buscar, ler, decidir o que buscar em seguida, ler de novo. Uma requisição HTTP comum não aguenta isso. Em Cloudflare Workers, o `waitUntil` (o mecanismo que deixa um trabalho rodar depois de a resposta sair) tem prazo curto e não guarda estado se algo cair no meio.

Havia também limites que não são técnicos. Nem todo artigo pode ser lido: o texto precisa ter licença que permita o uso. O gasto com modelo precisa de teto por item, não só por execução, senão um único item caro consome o orçamento dos outros. E dose de medicamento continua vindo só de bula, mesmo que um artigo cite uma.

## A solução

### Um Workflow em vez de uma requisição

Montei a pesquisa como um Cloudflare Workflow, que é um motor de execução durável: cada passo tem retentativa nativa e o resultado de cada passo fica persistido. Se a plataforma derruba um passo longo, ele roda de novo sem refazer os anteriores. Isso casou bem com a API de artigos, que responde 429 de vez em quando: só os passos de rede repetem, com espera exponencial. O status do Workflow virou o status que a API expõe para o cliente: em andamento, concluída ou falhou.

### Um planejador com orçamento de ações

Dentro do Workflow roda um laço curto. Um planejador de baixo custo escolhe uma ação por turno, entre buscar e ler, com no máximo 10 ações. Ler um artigo com id desconhecido ou repetido também conta como ação e volta como observação de erro, sem ir à rede. Assim o planejador não tem como entrar em laço.

Só entram artigos com texto completo de acesso aberto e licença compatível. Licença ausente ou restritiva recusa a leitura, e a ação conta do mesmo jeito. Preferi sínteses (diretrizes, revisões, consensos) a estudos primários, porque um estudo isolado cobre um desfecho e uma janela de exposição, e responder conduta só com ele tranquiliza por omissão.

### Mesmo gerador, mesmo contrato

Depois das leituras, um modelo de embedding ranqueia os trechos lidos contra a pergunta e as consultas do planejador. Os 8 melhores vão para o mesmo gerador e o mesmo contrato de checagens do caminho rápido. Se o rascunho falha no contrato, a pesquisa termina em abstenção, como no chat.

### Idempotência e isolamento

A pesquisa só abre para uma abstenção elegível: pergunta de conduta, sem fonte que sustente a resposta. O id da instância do Workflow é derivado do id do pedido, então repetir o pedido não abre uma segunda pesquisa. E a consulta do resultado só responde para quem abriu. Qualquer outro cliente recebe o mesmo erro de "pesquisa desconhecida", sem confirmar que o id existe.

## Um exemplo

A regra de teto é a parte que eu mais revisei. O orçamento disponível para um item é o menor entre o teto do item e o que sobra da execução inteira. A exploração (buscar e ler) só pode usar metade disso, e antes de gerar a resposta o gasto é conferido de novo. O código abaixo é uma versão simplificada da ideia, com nomes genéricos:

```ts
type Budget = { itemCap: number; runCap: number; runSpent: number };

function availableFor(budget: Budget): number {
  return Math.min(budget.itemCap, budget.runCap - budget.runSpent);
}

async function research(budget: Budget, ledger: CostLedger) {
  const limit = availableFor(budget);
  // explorar demais deixa o item sem dinheiro para gerar a resposta
  const exploreLimit = limit * 0.5;

  while (ledger.spent() < exploreLimit && planner.hasActionsLeft()) {
    await planner.nextAction();
  }

  // o ledger registra mesmo passos que falharam, então a conta é real
  if (ledger.spent() >= limit) {
    return abstain("ITEM_BUDGET_EXCEEDED");
  }
  return generateWithContract(await rankChunks(), ledger);
}
```

Com valores fictícios: teto de 10 centavos por item, teto de execução de 1 real e 95 centavos já gastos. O disponível é `min(10, 5) = 5` centavos. A exploração para em 2,5 centavos. Se, por causa de retentativas, o gasto chegar a 5 antes da geração, o item termina em abstenção sem chamar o gerador. Um item caro não come o orçamento do próximo.

O ponto que me fez mudar o desenho: o gasto vem de um ledger de custo, não de uma estimativa. Uma tentativa que falhou no meio também gastou, e o ledger guarda isso. Sem ele, cada retentativa parecia de graça e o teto mentia.

## Resultado

Medi o protótipo no mesmo conjunto de avaliação das outras estratégias do motor. Nos itens que exigiam abstenção, ele se absteve em todos. Nos itens de diretriz, respondeu parte deles sem erro crítico e com exatidão numérica bem melhor que um gerador sem fonte. O preço foi abstenção indevida em alguns casos e tempo: dezenas de segundos por item. Foi esse número que confirmou a decisão de deixar a pesquisa fora do chat rápido, como uma tarefa que avisa quando termina.

## O que eu levo disso

Qualquer tarefa que passa de alguns segundos e gasta dinheiro merece três coisas: estado persistido, idempotência pelo id do pedido e um teto que valha para o conjunto e para cada item. E o teto só funciona se a conta vier do que foi gasto de verdade, incluindo as tentativas que falharam.
