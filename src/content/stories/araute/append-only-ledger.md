---
title: Um livro-razão onde o banco só aceita INSERT
summary: "Um saldo que a aplicação soma e subtrai não explica de onde veio, e um erro corrigido na mão apaga o próprio rastro. Fiz um livro-razão em que o banco recusa edições, e explicar qualquer saldo virou uma consulta."
project: araute
order: 6
tags: [Ledger, PostgreSQL, Partidas dobradas, Idempotência, Pagamentos]
---

Um lojista abre o painel, vê o saldo disponível e pergunta: por que é esse valor? A única resposta aceitável numa plataforma de pagamentos é uma lista de lançamentos que somam exatamente aquele número, cada um apontando para a cobrança, a taxa ou o reembolso que o originou. "Porque a coluna diz isso" não é resposta. Foi com essa pergunta em mente que desenhei o ledger da Araute.

## O problema

Um saldo guardado como campo que a aplicação incrementa e decrementa tem dois defeitos. Não explica de onde veio. E, quando um cálculo sai errado, a correção natural é editar a linha, o que apaga justamente o rastro do erro.

Além disso, o dinheiro numa plataforma de pagamentos tem várias naturezas ao mesmo tempo: o que ainda está pendente, o que já é devido ao lojista, o que o provedor de Pix ou o adquirente ainda vai repassar, a taxa da plataforma, as reservas para disputa e reembolso, o crédito de um cliente. Um lançamento na conta errada não pode ser descoberto só no fechamento do mês.

## Por que não era trivial

A imutabilidade precisa resistir aos bugs da própria aplicação, não só a usuários mal-intencionados. Se a garantia mora só no código, o primeiro `UPDATE` esquecido num script de correção a desfaz.

E quem escreve no ledger são workers de fila, que entregam mensagens pelo menos uma vez. O mesmo evento pode chegar duas vezes, e um crédito duplicado é dinheiro que não existe.

## A solução

### Partidas dobradas

Cada evento financeiro vira um journal, um grupo de lançamentos em que a soma dos débitos é igual à soma dos créditos. A aplicação confere isso antes de gravar, e o banco confere de novo no fechamento do journal, na mesma transação. Journal desbalanceado aborta a transação inteira; nunca existe meio journal persistido.

Como cada journal fecha em zero, o razão inteiro fecha em zero a qualquer instante. Essa soma virou a checagem mestre: se ela não for zero, há um bug, e eu sei disso na hora.

### Imutável no banco, não na aplicação

A tabela de lançamentos só aceita INSERT, e quem garante isso é o PostgreSQL. O usuário de banco da aplicação não tem permissão de UPDATE nem DELETE nessa tabela, e um trigger levanta erro nos dois casos, como segunda camada. Mesmo um script rodado com credenciais erradas esbarra no trigger.

### Correção só por lançamento inverso

Erro se corrige com um journal de reversão: ele espelha o original com as direções trocadas e referencia o journal que está desfazendo. O saldo é sempre a soma de tudo. O erro continua visível, e a correção também.

### Todo lançamento tem origem

Nenhuma entrada solta. Cada lançamento aponta para o objeto financeiro que o gerou, como uma cobrança, um reembolso ou um repasse. Não existe "ajuste" sem dono.

### Chave determinística por journal

Cada journal tem uma chave derivada do evento que o originou, e o banco tem uma restrição de unicidade sobre ela. Se o worker reprocessa o mesmo evento, o segundo INSERT colide e o worker trata como "já lancei". Um caso concreto: a liberação do saldo pendente de uma cobrança usa uma chave por cobrança, então uma rotina periódica rodando duas vezes nunca libera o mesmo dinheiro duas vezes.

### Centavos inteiros e arredondamento com destino

Valores são inteiros positivos em centavos, e a direção (débito ou crédito) carrega o sinal. Todo rateio que gera fração de centavo, como uma taxa percentual, usa o mesmo arredondamento half-up (meio centavo sobe), e o resíduo vai para uma conta determinada dentro do journal. Nada some, porque sumir quebraria o balanço.

### Saldos com regra própria

Algumas contas nunca podem ficar negativas, e a operação que as deixaria negativas é rejeitada. Outras podem, por decisão explícita: se um estorno sai antes de o lojista ter saldo, o valor a pagar a ele fica negativo, o que significa que ele deve à plataforma. Isso é sinalizado, não bloqueado, porque o lançamento precisa refletir a realidade.

## Um exemplo

Uma cobrança Pix de R$ 100,00 com taxa de 1,99%. A taxa dá 199 centavos exatos, então não há resíduo. Na confirmação do pagamento, o journal fica assim:

| Conta | Débito | Crédito |
| --- | ---: | ---: |
| A receber do provedor | 10000 | |
| Saldo pendente do lojista | | 9801 |
| Receita de taxa da plataforma | | 199 |
| **Total** | **10000** | **10000** |

Dias depois, o lojista reembolsa a cobrança. Nada é editado. Um novo journal entra, referenciando a cobrança, com as direções trocadas. O saldo do lojista é a soma das duas linhas, e o histórico mostra as duas.

A gravação, de forma simplificada, fica assim:

```sql
BEGIN;

INSERT INTO journals (id, journal_key, source_kind, source_ref)
VALUES ('jrn_01', 'charge.succeeded:ch_123', 'charge', 'ch_123')
ON CONFLICT (journal_key) DO NOTHING
RETURNING id;
-- nenhuma linha devolvida: o evento já foi lançado, o worker encerra aqui

INSERT INTO journal_entries (journal_id, account, direction, amount_cents) VALUES
  ('jrn_01', 'provider_receivable', 'debit',  10000),
  ('jrn_01', 'merchant_pending',    'credit',  9801),
  ('jrn_01', 'platform_fee',        'credit',   199);

COMMIT; -- o trigger de fechamento confere débito = crédito antes de aceitar
```

E qualquer tentativa de "consertar" um valor direto falha no banco:

```sql
UPDATE journal_entries SET amount_cents = 9800 WHERE journal_id = 'jrn_01';
-- ERROR: journal entries are append-only
```

## Resultado

O ledger virou a fonte de verdade contábil da plataforma. A conciliação com o provedor compara o extrato contra ele, e as divergências viram registros próprios em vez de ajustes silenciosos. Um reembolso só é lançado quando chega ao estado final de sucesso, nunca antecipado enquanto ainda está pendente.

Responder "por que o saldo é esse?" virou uma consulta, não uma investigação.

## O que eu levo disso

Imutabilidade é propriedade do banco, não da aplicação. Permissão e trigger custam meia dúzia de linhas e protegem contra o erro mais provável, que é o meu. E todo journal precisa de uma chave determinística desde o primeiro dia, porque quem escreve em ledger vai ser reexecutado.
