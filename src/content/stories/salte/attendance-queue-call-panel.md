---
title: "Fila de atendimento e painel de chamada: senha única, prioridade legal e uma TV sem login"
summary: "A recepção precisa de senhas que nunca se repetem no dia, prioridade legal respeitada e uma TV na sala de espera que chama o paciente sem expor quem ele é. Desenhei a numeração com lock por dia e prefixo, a ordem por prioridade e chegada e um painel público por link secreto que anuncia cada chamada uma vez só."
project: salte
order: 4
tags: [ERP, PostgreSQL, Concorrência, TanStack Query, Privacidade, Recepção]
---

Segunda-feira, oito da manhã, recepção cheia. Duas recepcionistas fazem check-in ao mesmo tempo. Uma senhora de 78 anos chega depois de um rapaz, mas tem prioridade por lei. O médico chama a próxima pessoa, e a TV da sala de espera toca um sinal e fala o nome e o consultório. O paciente não aparece, o médico chama de novo. Tudo isso parece trivial para quem está na sala. Por trás, cada passo tem uma regra que não pode falhar na frente de vinte pessoas.

## O problema

A fila de atendimento da Salte acompanha o paciente por etapas: caixa, triagem e atendimento. Cada etapa é uma entrada na fila, com estado (aguardando, chamado, em atendimento, concluído ou cancelado), e a etapa seguinte herda a mesma senha.

O módulo tinha quatro exigências: senhas que nunca se repetem no mesmo dia, mesmo com check-ins simultâneos; uma ordem que respeita a prioridade legal sem bagunçar a chegada dos demais; uma forma de desfazer e refazer um check-in sem o paciente perder o lugar; e um painel de chamada numa TV que não tem usuário logado, não pode mostrar dado sensível e precisa anunciar cada chamada exatamente uma vez.

## Por que não era trivial

Senha sequencial é o exemplo clássico de corrida: duas transações leem o maior número, somam um e gravam o mesmo valor. "Dia" também não é óbvio: é o dia da clínica, no fuso dela, não o dia em UTC do servidor.

A TV é um dispositivo público. Qualquer pessoa na sala pode ver a tela e, se o endereço vazar, acessá-lo de fora. Ela não tem como fazer login, liga e desliga sem aviso, perde rede e volta. E se ao ligar ela anunciar todas as chamadas da manhã, a sala inteira ouve uma lista de nomes.

## A solução

### Senha por clínica, dia e prefixo, com lock

A senha tem um prefixo (A para agendamento com check-in, S para senha avulsa de quem chegou sem marcar) e um número com três dígitos. O contador é por clínica, dia da clínica e prefixo, e o dia é calculado no fuso configurado da clínica e guardado como data simples, para não andar com fuso horário.

A geração toma um lock de transação do Postgres (um advisory lock com a chave clínica, dia e prefixo) antes de ler o maior número e somar um. Duas recepcionistas no mesmo segundo esperam uma pela outra e recebem números consecutivos. Um índice único sobre os mesmos campos fica de rede de segurança: se algo escapar, a transação falha com conflito, em vez de gravar senha repetida.

Outro índice garante uma única entrada aberta por agendamento e etapa, e a checagem de "já fez check-in?" é repetida depois de pegar o lock. Dois cliques simultâneos no check-in devolvem a mesma senha.

### Prioridade legal, depois chegada

A prioridade da fila tem três níveis: normal, prioritário e urgente. Ela é separada do motivo legal (idoso, gestante, pessoa com deficiência, autismo, mobilidade reduzida, lactante, criança de colo), que é guardado junto para registro. No check-in, qualquer motivo legal vira prioritário; urgência só pode ser marcada numa senha avulsa, explicitamente.

A ordem vem de uma coluna gerada no banco com o peso da prioridade, e a fila ordena por peso decrescente, depois hora de chegada, depois id. Um índice cobre exatamente essa ordem. Quem chama é sempre uma pessoa, escolhendo da lista; o sistema não chama sozinho.

### Desfazer sem perder o lugar

Desfazer o check-in cancela a entrada com um motivo próprio. Fazer check-in de novo recupera a mesma entrada: mesma senha e mesma hora de chegada original, portanto o mesmo lugar na fila. Rechamar alguém incrementa o contador de chamadas no próprio SQL, para duas chamadas simultâneas não perderem uma.

### Uma TV com link secreto, sem login

Um gestor cria um link de TV nas configurações, com escopo (recepção, atendimento ou tudo) e, se quiser, preso a uma sala. O link carrega um token de 32 bytes aleatórios. No banco ficam o hash, para achar o token, e uma cópia cifrada, para o gestor poder ver o link de novo. Revogar marca o link; token inexistente, malformado ou revogado recebem o mesmo 404.

A rota pública monta a resposta campo a campo: senha, nome de exibição, sala, tipo e número de chamadas. O nome é abreviado em toda leitura: primeiro nome mais a inicial do último sobrenome, pulando "da", "de", "dos" e afins. O feed traz só chamadas do dia da clínica, dentro do escopo, uma linha por senha, no máximo cinco.

### Atualização por consulta periódica, anúncio uma vez

A TV pergunta ao servidor a cada cinco segundos. Para um painel que mostra cinco linhas, isso é mais simples e mais robusto que manter um socket aberto num aparelho que liga e desliga, e cinco segundos é um atraso que ninguém na sala percebe.

O anúncio é decidido no navegador da TV. A primeira resposta depois de ligar é tratada como histórico e não toca nada. Uma chamada é anunciada quando o id é novo ou quando o número de chamadas subiu, o que cobre a rechamada; chamadas que chegam durante um anúncio esperam na fila. O anúncio toca três notas e fala em português, um pouco mais devagar que o normal, porque a sala tem muitos idosos. Sem dados novos por 60 segundos, a tela mostra que está sem conexão e há quanto tempo, com as idades das chamadas calculadas pela hora do servidor. Se o navegador bloquear o som, a TV pede um toque na tela.

Um job diário encerra as entradas que ficaram abertas em dias anteriores, com uma tolerância de um dia para quem ainda estava em atendimento.

## Um exemplo

Uma manhã fictícia, fuso de São Paulo:

| Hora | Evento | Fila (ordem) | TV |
| --- | --- | --- | --- |
| 08:02 | Carlos faz check-in, sem prioridade | A001 | nada |
| 08:05 | Maria, 78 anos, faz check-in | A002 (prioritário), A001 | nada |
| 08:06 | Rafael chega sem agendamento | A002, A001, S001 | nada |
| 08:10 | Médico chama A002 para o Consultório 3 | A001, S001 | "Senha A002. Paciente Maria L., dirija-se ao Consultório 3" |
| 08:13 | Maria não vem; médico chama de novo | A001, S001 | anuncia de novo, na mesma linha |
| 08:20 | Duas recepcionistas fazem check-in juntas | ... A003, A004 | nada |

A decisão de anunciar, simplificada:

```ts
type Call = { id: string; recallCount: number };

function callsToAnnounce(feed: Call[], seen: Map<string, number>, firstLoad: boolean): Call[] {
  const fresh = feed.filter((call) => (seen.get(call.id) ?? -1) < call.recallCount);
  for (const call of feed) seen.set(call.id, call.recallCount);
  // ao ligar, o que já está na tela é histórico: ninguém quer ouvir a manhã inteira
  return firstLoad ? [] : fresh;
}
```

## Resultado

Senhas nunca se repetem no dia, nem com check-ins simultâneos, e o banco recusa o que o lock deixasse escapar. A prioridade legal é respeitada de forma previsível, e desfazer um check-in não tira ninguém do lugar. A TV funciona com um link que pode ser revogado, mostra só o necessário para a pessoa se reconhecer e anuncia cada chamada uma vez, inclusive depois de cair a rede ou ser desligada da tomada.

## O que eu levo disso

Numeração sequencial é um problema de concorrência antes de ser um problema de formatação. Dispositivo público pede o mínimo de dado e uma credencial revogável, não uma sessão. E nem todo tempo real precisa de socket: quando a tela é pequena e o atraso aceitável é de segundos, perguntar periodicamente e decidir no cliente o que é novo é mais simples e mais difícil de quebrar.
