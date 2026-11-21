---
title: "Régua de cobrança: só a fatura do ciclo move a assinatura"
summary: "Uma régua de cobrança precisa saber quais faturas podem colocar a clínica em atraso, de quando conta o prazo de carência e como somar pagamentos que chegam juntos. Desenhei essas três regras e as amarrei em testes de ponta a ponta."
project: salte
order: 12
tags: [Billing, Régua de cobrança, PostgreSQL, Concorrência, Assinaturas]
---

Uma clínica em dia com o plano mensal resolve comprar um pacote extra de créditos, e o cartão recusa essa compra avulsa por limite. A mensalidade está paga. O que falhou foi uma compra de R$ 89,00 que ela pode tentar de novo com outro cartão. O que a régua de cobrança deve fazer com essa recusa? Nada com a assinatura, claro. Mas "claro" só vale se a regra estiver escrita no código e coberta por teste.

## O problema

O billing da plataforma tem uma régua de cobrança, o processo que reage a pagamentos falhos (dunning, no jargão). No cartão, ela retenta a cobrança em intervalos de 1, 2, 4, 5 e 7 dias. A assinatura entra em atraso, ganha sete dias de carência, passa a inadimplente e, quinze dias depois, é cancelada por falta de pagamento.

Conforme o billing ganhou compras avulsas, recargas, módulos extras e o fluxo de 3D Secure, três perguntas que a primeira versão da régua respondia de forma implícita precisaram de resposta explícita:

- Que fatura recusada pode mover a assinatura para atraso? A versão inicial olhava só se a fatura tinha assinatura, o que incluiria compras avulsas, recargas e proração de módulo extra.
- De quando conta a carência? Contar do fim do ciclo dá menos dias a uma cobrança que falha mais tarde do que a regra promete.
- Como somar o valor pago quando webhook, retentativa e conciliação liquidam a mesma fatura ao mesmo tempo? Ler, somar na aplicação e gravar de volta perde atualização.

Revisei as três na mesma rodada, com testes cobrindo cada combinação.

## Por que não era trivial

Cada regra tem uma implementação pequena, mas as três mexem no coração do billing, onde um erro vira cobrança indevida ou cancelamento indevido. A régua também tem caminhos diferentes por meio de pagamento, e o caso de autenticação do cartão (3D Secure) usa a mesma entrada em atraso para fazer o prazo correr. Uma regra que olhasse só o cartão recusado deixaria esse caminho inconsistente.

E havia assinaturas criadas antes do novo marco de tempo existir, que precisavam continuar funcionando sem migração.

## A solução

### Só a fatura do ciclo move a assinatura

A pergunta certa é "pagar esta fatura tira a assinatura do atraso?". Só a fatura recorrente do ciclo responde sim. Uma compra avulsa recusada fica aberta para ser paga pela tela de faturas, sem tocar no estado da assinatura e sem entrar na régua. A mesma regra vale para o caminho do 3D Secure: autenticação exigida numa compra avulsa não coloca a assinatura em atraso.

A retentativa sem o cliente também é restrita à fatura do ciclo. Fatura avulsa nunca é retentada automaticamente: quem decide pagar é a pessoa.

### Carência ancorada no momento do atraso

A assinatura ganhou um campo com o instante em que entrou em atraso, gravado na entrada e limpo na saída. A escalada para inadimplente usa esse instante mais sete dias. Para as linhas antigas, sem o campo, a conta cai para o fim do ciclo. Nenhuma migração de dados foi necessária.

### Pagamento acumulado num único UPDATE

O valor pago nunca é lido e regravado pela aplicação. Cada liquidação incrementa o valor no próprio SQL, recalcula o saldo devedor e promove a fatura a paga na mesma instrução, quando o total é alcançado. A instrução devolve se a fatura acabou de ficar paga, e só então os efeitos dessa transição disparam: e-mail, ativação, auditoria. Estornos seguem o mesmo desenho, com a fatura virando estornada ou parcialmente estornada pela soma acumulada.

### O que a tela mostra

A fatura expõe quantas tentativas falharam e quando será a próxima, mas só enquanto ela está aberta e a próxima tentativa está no futuro. Uma data de retentativa no passado, ou numa fatura já paga, só confundiria.

## Um exemplo

Uma clínica fictícia, mensalidade de R$ 349,00 paga no dia 1:

| Dia | Evento | Regra ingênua | Regra final |
| --- | --- | --- | --- |
| 3 | Compra avulsa de R$ 89,00 recusada | Assinatura em atraso, retentativas agendadas | Assinatura ativa, fatura avulsa aberta |
| 4 | Dona paga a avulsa com outro cartão | Assinatura volta a ativa | Nada muda na assinatura |
| 36 | Mensalidade do ciclo que terminou no dia 31 é recusada | Atraso, carência contada do dia 31: acaba no dia 38, dois dias depois da falha | Atraso desde o dia 36, carência até o dia 43 |

O incremento atômico, em SQL simplificado:

```sql
UPDATE invoices
   SET amount_paid  = amount_paid + $2,
       amount_due   = GREATEST(0, total - (amount_paid + $2)),
       status       = CASE WHEN amount_paid + $2 >= total THEN 'PAID' ELSE status END,
       paid_at      = CASE WHEN amount_paid + $2 >= total THEN now() ELSE paid_at END
 WHERE id = $1
RETURNING (status = 'PAID' AND amount_paid - $2 < total) AS became_paid;
```

Com dois webhooks liquidando a mesma fatura de R$ 349,00 em parcelas de R$ 200,00 e R$ 149,00 ao mesmo tempo, o banco serializa as duas atualizações na mesma linha. A primeira devolve `became_paid = false`, a segunda `true`, e o e-mail de pagamento confirmado sai uma vez só. Num desenho de ler, somar e regravar, as duas leriam zero e a última gravaria R$ 149,00.

## Resultado

Compra avulsa recusada não assusta cliente adimplente. A carência é exatamente a prometida, contada de quando o atraso começou. E o valor pago de uma fatura não perde atualização quando webhook, retentativa e conciliação chegam juntos. Cada regra tem testes de ponta a ponta: compra avulsa, módulo recorrente, retentativa, webhook do cartão e o tempo-limite de autenticação.

## O que eu levo disso

Numa máquina de estados, cada transição precisa responder "este evento deveria mover este estado?". Quando a resposta é "depende do tipo", o tipo tem de estar na condição. E todo prazo precisa de um marco próprio, gravado no momento em que o relógio começa, em vez de ser deduzido de outro campo que por acaso costuma estar perto.
