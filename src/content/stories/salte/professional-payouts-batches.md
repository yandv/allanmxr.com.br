---
title: Repasse a profissionais em lotes, com a regra congelada na cobrança
summary: "Uma clínica paga cada profissional pelo que ele atendeu, com regras que mudam com o tempo e um Pix que não tem volta. Desenhei o repasse para congelar a regra em cada linha cobrada e pagar em lotes que verificam saldo antes de começar e falham por profissional, não pelo lote inteiro."
project: salte
order: 2
tags: [Financeiro, Repasse, Pix, PostgreSQL, ERP]
---

É fim de mês numa clínica com oito profissionais. A gestora abre o fechamento do repasse: quanto cada um tem a receber pelas consultas e procedimentos que atendeu e que os pacientes já pagaram. Uma dermatologista ganha 40% das consultas; um fisioterapeuta ganha um valor fixo por sessão; uma regra foi renegociada no dia 15. A gestora confere, digita o PIN e manda. Oito Pix saem da conta da clínica. Se um deles falhar, os outros sete não podem ficar esperando, e nenhum pode sair em dobro.

## O problema

Repasse é a parte do faturamento da clínica que vai para o profissional que executou o serviço. Ele parece uma conta simples, porcentagem vezes valor, mas tem três perguntas difíceis por trás: com qual regra calcular, quando o valor passa a contar e como pagar um grupo de pessoas de uma vez com um meio de pagamento que não tem desfazer.

Regras de repasse mudam. Se o cálculo fosse refeito no fechamento com a regra vigente, uma renegociação no meio do mês reescreveria o passado. E o pagamento sai por Pix da conta da clínica: uma transferência enviada não volta por rollback de banco de dados.

## Por que não era trivial

A regra tem dois tipos: porcentagem do valor da linha ou valor fixo por unidade. Ela pode ser do profissional naquele serviço ou o padrão da clínica para o serviço, e um profissional pode ter preço próprio sem ter regra própria.

O valor só conta quando o dinheiro entra. Uma consulta feita no dia 30 e paga no dia 2 é do mês seguinte. E um profissional pode transferir parte do saldo para um colega, então "quanto ele pode receber" não é só a soma das consultas.

No pagamento, cada profissional precisa de uma chave Pix padrão, a conta da clínica precisa ter saldo e o envio pode terminar sem resposta clara do banco. Tudo isso para vários profissionais no mesmo clique.

## A solução

### A regra é congelada na linha da cobrança

Quando a cobrança é criada, cada linha guarda uma fotografia da regra: tipo, valor, profissional que executou e o valor do repasse já calculado. A porcentagem é guardada em pontos-base (10.000 é 100%), para trabalhar com inteiros. O fechamento só soma o que está gravado, nunca recalcula. Renegociar uma regra vale dali para frente, por desenho.

A regra vencedora segue uma ordem: a regra do profissional no serviço, se tiver valor; senão, a regra padrão do serviço na clínica; senão, nenhum repasse. Um zero gravado conta como "sem regra", para não gerar linhas de R$ 0,00. A base é o valor bruto da linha: desconto concedido ao paciente na cobrança não reduz o repasse.

Venda de pacote de sessões gera repasse zero no dia da venda. Cada sessão entregue congela o próprio repasse para quem de fato atendeu.

### Só conta o que foi pago

O saldo realizado olha apenas cobranças pagas, pela data do pagamento. Uma visão separada mostra o esperado, com o que ainda está para receber, sem misturar as duas coisas na tela do fechamento.

### O lote reserva as linhas

Cada repasse de um lote liga as linhas de cobrança que está pagando. Um índice único parcial garante que uma linha esteja em no máximo um repasse ativo: dois fechamentos simultâneos não pagam a mesma consulta, o segundo recebe um conflito. O saldo disponível de cada profissional (realizado, menos o já pago, menos o transferido para colegas, mais o recebido) é calculado sob um lock por profissional.

### Pagar sem uma transação gigante

Antes de criar qualquer coisa, o lote faz uma simulação e confere se a conta da clínica tem saldo para o total. Se não tem, o lote inteiro é recusado de cara, sem nenhum Pix enviado.

Depois, cada profissional é pago em transações curtas e separadas, de propósito: juntar as linhas, conferir a chave padrão e o saldo, registrar a tentativa de Pix antes de enviar, enviar e marcar como pago. Uma transação única para o lote seria uma mentira, porque o Pix enviado não volta num rollback.

O lote é gravado como "processando" antes do primeiro envio, então uma interrupção aparece como interrupção, nunca como um "pago" falso. No fim, ele termina pago, parcial ou falho.

### Falhas por profissional, com motivo

Um repasse que não sai fica pendente com um motivo legível: profissional sem chave Pix, orçamento do lote esgotado, chave recusada pelo banco, limite de Pix da conta atingido ou resultado desconhecido. Saldo insuficiente para o envio interrompe os que ainda estão na fila, mas todos aparecem com o motivo. Profissional sem chave fica fora da conta de saldo, para não bloquear os colegas.

"Tentar de novo" só existe para lotes parciais ou falhos. Primeiro pergunta ao banco o destino de qualquer envio com resultado desconhecido; depois cancela e junta de novo, já incluindo o que o profissional ganhou nesse meio tempo.

### Pix devolvido depois

Se um Pix de repasse volta depois de liquidado, o repasse vira estornado, uma receita compensatória é lançada na data da despesa original e as linhas são liberadas para o próximo lote. Assim, o repasse de julho devolvido em agosto não distorce julho.

## Um exemplo

Valores fictícios, fórmulas reais:

| Linha | Preço | Regra vencedora | Repasse |
| --- | --- | --- | --- |
| Consulta da Ana | R$ 300,00 | da Ana: 40% (4.000 pontos-base) | R$ 120,00 |
| Procedimento da Ana, 2 unidades | R$ 80,00 cada | padrão da clínica: R$ 25,00 por unidade | R$ 50,00 |
| Consulta do Bruno | R$ 333,33 | do Bruno: 35% | R$ 116,67 |

A consulta da Ana teve R$ 30,00 de desconto para o paciente, que pagou R$ 270,00. O repasse continua R$ 120,00, porque a base é bruta.

```ts
type Rule = { kind: 'PERCENT' | 'FIXED'; value: number }; // PERCENT em pontos-base

function payoutCents(lineTotalCents: number, quantity: number, rule: Rule): number {
  if (rule.kind === 'FIXED') return rule.value * quantity;
  return Math.round((lineTotalCents * rule.value) / 10_000); // 33333 * 3500 / 10000 = 11666,55 -> 11667
}
```

No fechamento, o total é R$ 170,00 para a Ana e R$ 116,67 para o Bruno, R$ 286,67 no lote. Com R$ 200,00 na conta, o lote é recusado antes de qualquer envio. Se o Bruno não tivesse chave Pix, o total exigido seria R$ 170,00: o lote sairia, terminaria parcial, e o repasse do Bruno ficaria pendente com "O profissional não tem chave PIX cadastrada", esperando o próximo "tentar de novo".

## Resultado

O fechamento do mês é uma soma de números congelados, conferível linha a linha, e uma regra renegociada não reescreve o passado. Um lote nunca começa sem saldo, nunca paga a mesma consulta duas vezes e, quando algo falha, falha para um profissional, com motivo, sem segurar os outros. O pagamento exige a permissão de gerir o financeiro e o PIN de quem executa, e o nome de quem confirmou fica registrado no lote.

## O que eu levo disso

Em dinheiro, o número que importa é o do momento em que a obrigação nasceu, não o do momento em que alguém olha. Congelar na origem simplifica tudo depois. E quando um passo não tem desfazer, como um Pix, a transação certa é pequena: uma por efeito irreversível, com o estado gravado antes de agir.
