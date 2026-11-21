---
title: "Do atendimento ao recebível do convênio: guias, pendências e lotes mensais"
summary: "Cada consulta por convênio vira uma guia, as guias do mês viram um lote e o lote vira um título a receber que encolhe quando o convênio glosa. Desenhei a guia para nascer ao finalizar a consulta sem arriscar o prontuário, com preço da tabela do dia e uma lista de pendências que barra o lote antes de ele sair errado."
project: salte
order: 5
tags: [Convênios, Faturamento, PostgreSQL, Contas a receber, ERP]
---

Uma oncologista finaliza a sessão de quimioterapia de uma paciente de convênio. Naquele atendimento houve a consulta, um exame feito na própria clínica e a aplicação de dois medicamentos do estoque. Para a clínica receber, tudo isso precisa virar uma guia do convênio, com cada item no preço da tabela daquele convênio, e no fim do mês entrar num lote junto com as outras guias. Se a guia sai com um item sem preço, uma carteirinha vencida ou uma dose acima da prescrita, o convênio glosa, ou seja, recusa o pagamento daquele item, e a clínica descobre semanas depois.

## O problema

Faturar convênio é transformar eventos clínicos em cobrança, com regras de cada pagador. A guia precisa nascer do atendimento sem retrabalho, ter o preço certo para o dia do atendimento, carregar taxas que o convênio aceita e só entrar no lote quando não tiver nada que faça o convênio recusá-la. Depois, o lote vira um título em contas a receber, e o valor desse título precisa acompanhar o que o convênio de fato aceitar pagar.

## Por que não era trivial

O prontuário e o faturamento têm pesos diferentes. Finalizar a consulta é um registro clínico; gerar a guia depende de tabela de preço, de lock de faturamento e de regras do convênio. Uma falha no faturamento não pode desfazer o registro clínico.

O preço também tem data. A tabela do convênio muda, e a guia precisa do preço vigente no dia do atendimento, não no dia em que alguém abre a tela. Quando não há preço, a tentação é usar o preço particular, e isso produz uma guia que o convênio vai recusar.

E um lote é um compromisso. Depois de enviado e pago, desfazê-lo apagaria a ligação entre o dinheiro recebido e as guias que o justificam.

## A solução

### A guia nasce depois do commit clínico

A finalização da consulta grava o registro clínico na transação da rota. Só depois do commit a guia é gerada, e a resposta volta com a referência dela, para a tela anunciar "guia gerada". Se a geração falhar, a falha vira log e a resposta traz a guia como nula. Um consumidor do evento de consulta finalizada faz a geração de novo em segundo plano. A guia é única por consulta, com índice e uma releitura sob lock, então quem chegar segundo recebe a guia que já existe.

A geração decide quem paga pelo agendamento, ou pela carteirinha do paciente quando ele chegou sem agendar. Consulta particular continua particular mesmo que o paciente tenha convênio, e o dia do atendimento é o dia da clínica no fuso dela.

### Preço da tabela do dia, nunca o particular

Cada item procura o preço da tabela do convênio vigente no dia do atendimento. Sem preço, o item fica sem valor e a guia fica em "falta preço"; ele nunca recebe o preço particular. Quando o convênio publica o preço, uma reprecificação lê a tabela de novo, no mesmo dia do atendimento, e a guia sai desse estado. Itens digitados à mão mantêm o valor digitado.

### Taxas por regra, uma vez por guia

Um convênio pode ter regras de taxa, como uma taxa de aplicação sempre que há medicamento do estoque na guia. A guia recebe uma linha por regra ativa cujo gatilho vale, uma única vez, com índice único impedindo a segunda. Se alguém remove uma taxa da guia, a remoção é lembrada, e a reprecificação não a traz de volta.

Exames feitos na clínica e não cobrados do paciente entram como linhas de procedimento no preço da tabela. Exame sem código válido fica sem código, nunca com um código inventado, e aparece como pendência.

### Pendências que bloqueiam o lote

Cada guia passa por uma lista de checagens, cada uma com campo, mensagem e se bloqueia ou só avisa. Exemplos: carteirinha ausente ou vencida, registro do convênio ou código da clínica faltando, data de atendimento no futuro, prazo de envio vencido, autorização vencida ou posterior ao atendimento, item sem valor, total que não fecha, despesa de medicamento acima da dose prescrita. Avisos, como medicamento sem prescrição associada, aparecem sem bloquear.

### O lote vira um título a receber

O lote junta guias de um convênio, de um mesmo tipo e de um período, normalmente o mês. Antes de fechar, uma prévia mostra o que entraria e, para cada guia de fora, o motivo e a primeira pendência. Fechar pega só guias prontas e sem pendência bloqueante, cria um título em contas a receber com o convênio como cliente e marca as guias como faturadas com um update condicional ao estado. Se o número de guias movidas não bate com o esperado, tudo volta atrás.

O título pertence ao lote: não se edita nem se apaga pelas contas a receber. Desfazer o lote devolve as guias e remove o título, mas só enquanto o convênio não devolveu demonstrativo e nenhum dinheiro entrou.

Quando o demonstrativo do convênio chega, cada item é casado com lote, guia e linha, e cada glosa é registrada com valor e código. Item que não casa fica guardado como "sem correspondência", nunca descartado. O valor do título passa a ser o faturado menos o glosado mais o recuperado em recurso, nunca abaixo de zero nem acima do faturado.

## Um exemplo

Uma guia fictícia de sessão:

| Item | Origem | Preço |
| --- | --- | --- |
| Consulta | tabela do convênio no dia do atendimento | R$ 250,00 |
| Exame feito na clínica | tabela do convênio, como procedimento | R$ 80,00 |
| Taxa de aplicação | regra do convênio, gatilho: medicamento do estoque | R$ 45,00 |
| Total | | R$ 375,00 |

Um lote de 40 guias como essa vira um título de R$ 15.000,00. O convênio glosa R$ 600,00, e o título vai a R$ 14.400,00. Um recurso recupera R$ 200,00, e o título vai a R$ 14.600,00.

```ts
function batchReceivableCents(billed: number, denied: number, recoveredOnAppeal: number): number {
  // o título nunca fica negativo nem passa do que foi faturado
  return Math.min(billed, Math.max(0, billed - denied + recoveredOnAppeal));
}

batchReceivableCents(1_500_000, 60_000, 20_000); // 1_460_000
```

Se o exame dessa guia não tivesse preço na tabela no dia, a guia ficaria em "falta preço" e fora do lote, aparecendo na prévia com o motivo, até a reprecificação achar o valor.

## Resultado

A guia aparece no momento em que o médico finaliza a consulta, sem que um problema de preço ou de lock possa desfazer o registro clínico. O lote só leva guias que passaram nas checagens, e a clínica vê, antes de fechar, o que ficou de fora e por quê. O título a receber acompanha glosas e recursos sem perder a ligação com as guias que o justificam.

## O que eu levo disso

Registro clínico e cobrança têm transações separadas porque têm consequências diferentes quando falham. Preço é sempre "preço em qual dia". E vale mais barrar uma guia na prévia, com o motivo na tela, do que descobrir a recusa no demonstrativo do mês seguinte.
