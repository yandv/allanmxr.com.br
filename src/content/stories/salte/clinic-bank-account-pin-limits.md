---
title: "A conta bancária dentro do ERP: PIN transacional, tetos de saída e Pix agendado"
summary: "Com a conta da clínica dentro do ERP, uma sessão aberta no computador da recepção não pode bastar para tirar dinheiro. Desenhei a saída de dinheiro com um PIN por pessoa, verificado a cada operação, tetos por transação e por 24 horas que não cedem a corrida e um Pix agendado que respeita as mesmas regras."
project: salte
order: 3
tags: [Pix, Woovi, Segurança, Financeiro, PostgreSQL, Cloudflare Workers]
---

A gestora financeira de uma clínica paga o laboratório, agenda o aluguel para o dia 5 e manda o repasse dos profissionais, tudo sem sair do ERP. A conta bancária da clínica vive ali dentro, por meio da Woovi: Pix de entrada e de saída, Pix agendado, boleto e transferências. É conveniente, e é exatamente isso que torna o desenho delicado. O computador da recepção fica com a sessão aberta o dia inteiro. Se estar logado bastasse para mover dinheiro, qualquer pessoa que sentasse ali, ou qualquer sessão roubada, poderia esvaziar a conta.

## O problema

A saída de dinheiro precisava de uma segunda barreira, independente da sessão, e de um teto que limitasse o estrago mesmo quando a barreira fosse vencida. Tudo isso sem tornar o dia a dia insuportável: a gestora faz dezenas de pagamentos legítimos.

Três peças saíram desse requisito: um PIN transacional por pessoa, verificado em cada operação de saída; tetos de saída por transação e por janela de 24 horas; e um Pix agendado que, rodando sozinho de madrugada, obedece às mesmas regras de quem está na tela.

## Por que não era trivial

Um PIN de seis dígitos tem só um milhão de combinações. Guardado com um hash comum, ele cai por força bruta em segundos se o banco vazar. Em Cloudflare Workers, as opções de hash lento são limitadas: não há argon2 nem scrypt, e o PBKDF2 tem teto de iterações.

As tentativas erradas precisam contar mesmo quando a requisição falha. Se a contagem morasse dentro da transação da rota, o rollback do erro apagaria a própria tentativa errada.

O teto de 24 horas tem uma corrida embutida: duas saídas simultâneas podem olhar a janela ao mesmo tempo, ver que cabe e passar as duas. E o agendado roda sem pessoa nenhuma para digitar o PIN.

## A solução

### O PIN pertence à pessoa, não à clínica

Cada pessoa tem o próprio PIN de seis dígitos. Ele é guardado com HMAC-SHA256 sobre uma chave secreta do servidor (o "pepper") e depois PBKDF2 com 100 mil iterações e sal aleatório, comparado em tempo constante. Com o PBKDF2 limitado pela plataforma, é o pepper, que não mora no banco, que protege os hashes num vazamento.

Cinco erros bloqueiam o PIN, e cada bloqueio dura mais que o anterior: 5 minutos, 30 minutos, 2 horas, 8 horas, 24 horas, 72 horas. O degrau mais alto não é permanente de propósito, para um ataque não virar um jeito de travar a gestora para sempre. Um acerto zera a contagem.

Além do limite global, cada verificação carrega um vínculo com a operação: tipo, valor e destino. Três erros no mesmo pagamento em uma hora pausam aquele pagamento, sem nem conferir o hash, enquanto o resto continua funcionando.

Não existe "PIN validado" guardado em cache. Toda operação de saída envia o PIN de novo. Cadastrar o PIN exige uma verificação extra da identidade, por código no e-mail ou pelo autenticador quando a pessoa tem MFA, para que uma sessão roubada não escolha o próprio PIN. Mover dinheiro exige ainda o vínculo com a clínica e a permissão de gerir o financeiro.

### A tentativa errada sobrevive ao erro

O middleware do PIN roda depois da validação do corpo e antes da transação da rota. Assim, o contador de erros é gravado e confirmado mesmo que a requisição termine em erro. Cada tentativa, certa ou errada, vira um registro de auditoria com IP; se uma tentativa certa não puder ser registrada, a operação é recusada.

### Tetos que não cedem à corrida

Cada conta tem um teto por transação e um teto numa janela deslizante de 24 horas. A janela é deslizante, não o dia do calendário, porque um dia que zera à meia-noite permite gastar o dobro do teto entre 23h59 e 00h01. Ela soma Pix, boletos e transferências em processamento ou concluídos; falhas não contam.

A corrida se resolve com duas checagens. A primeira acontece antes de gravar a saída. A segunda, depois de gravar a linha da saída em processamento, quando ela já conta a si mesma. Se uma saída concorrente fez a janela estourar, esta linha é marcada como falha antes de chegar à Woovi. Nesse desenho, as duas concorrentes podem ser recusadas, mas o teto nunca é ultrapassado.

Nenhuma rota da API altera os tetos. Uma sessão roubada com permissão de financeiro não consegue subir o limite antes de esvaziar a conta.

### Pix agendado com as mesmas regras

O agendado exige PIN na criação, e o vínculo do PIN cobre valor, chave, data, frequência e data de fim. Uma série sem data de fim não termina nunca, então o fim também precisa ser assinado. A data precisa estar no futuro e a no máximo um ano.

Na criação, o valor passa pelo teto por transação e pelo teto de 24 horas medido em volta da data agendada, olhando para os dois lados, já que agendar em ordem inversa furaria uma janela que só olhasse para trás. Na execução, a checagem que vale é a de saída comum.

Um job a cada cinco minutos pega os agendados vencidos, reivindica cada um com um update condicional ao estado, e executa em nome de quem criou, sem pedir o PIN de novo: ele foi dado na criação, para aquela operação exata. Repetição mensal ancora no dia original (31, depois 28 em fevereiro, depois 31 de novo). Se o job ficou fora do ar, ele pula para a próxima data futura em vez de disparar todas as perdidas de uma vez. Cancelar só funciona enquanto o agendado não começou a rodar; depois disso, a resposta é um conflito.

## Um exemplo

Uma clínica fictícia, com teto de R$ 10.000 por transação e R$ 150.000 em 24 horas. Às 14h, já saíram R$ 142.300 nas últimas 24 horas.

| Hora | Ação | Resultado |
| --- | --- | --- |
| 14:00 | Pix de R$ 9.500 ao laboratório | Recusado: 142.300 + 9.500 passa de 150.000 |
| 14:01 | Pix de R$ 7.000, PIN errado três vezes | Aquele pagamento fica pausado por uma hora |
| 14:03 | Mais dois erros em outras operações | Cinco erros: PIN bloqueado por 5 minutos |
| 14:10 | Ela e um colega mandam R$ 7.000 ao mesmo tempo | As duas passam na primeira checagem; a segunda vê 156.300, e pelo menos uma vira falha antes de sair |
| 14:20 | Agenda aluguel de R$ 12.000 para o dia 5 | Recusado na criação: acima do teto por transação |

A segunda checagem do teto, simplificada:

```ts
async function sendPix(accountId: string, amountCents: number) {
  await assertFitsWindow(accountId, amountCents); // 1ª: antes de existir a linha
  const row = await insertOutbound({ accountId, amountCents, status: 'PROCESSING' });
  // 2ª: agora a linha conta a si mesma; quem correu junto também já está somado
  if (!(await windowStillFits(accountId))) {
    await markFailed(row.id, 'limite de 24 horas atingido por envio simultâneo');
    return row;
  }
  return provider.sendPix(row);
}
```

## Resultado

Sessão aberta não move dinheiro: cada saída pede o PIN da pessoa, ligado àquela operação, com bloqueio progressivo e trilha de auditoria. Os tetos limitam o estrago no pior caso e não cedem a envios simultâneos. O agendado roda sozinho sem afrouxar nenhuma dessas regras. Um teste percorre todas as rotas que movem dinheiro e falha se alguma não tiver a barreira do PIN.

## O que eu levo disso

Dinheiro pede uma barreira por operação, não por sessão. Contadores de segurança precisam sobreviver ao erro que eles mesmos provocam. E quando duas checagens simultâneas podem errar para cima, vale aceitar recusar as duas para garantir que o teto nunca seja ultrapassado.
