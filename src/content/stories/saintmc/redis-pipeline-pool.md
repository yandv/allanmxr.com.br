---
title: Uma viagem ao Redis em vez de quatro, com pipeline e pool
summary: "Nos picos, cada mudança de estado de uma sala pede vários comandos ao Redis, e com poucas conexões as tarefas fariam fila. Juntei escrita e aviso numa única viagem e dimensionei as conexões para o volume real."
project: saintmc
order: 4
tags: [Redis, Jedis, Pipeline, Pool de conexões, Java]
---

Fim de partida em várias salas ao mesmo tempo. Cada uma anuncia o vencedor, troca de fase, sorteia o próximo mapa, devolve os jogadores ao lobby. Cada um desses passos mexe no Redis: grava o estado da sala, atualiza a lista de jogadores, avisa o proxy. Naquele minuto, dezenas de tarefas assíncronas querem falar com o Redis ao mesmo tempo, e cada uma faz várias perguntas em sequência, esperando a resposta de cada uma antes de fazer a próxima.

## O problema

No SaintMC, o Redis era o ponto de encontro da rede. Por ele passavam o registro dos servidores, o estado das partidas, a entrada e saída de jogadores, o cache das contas e os avisos entre processos via Pub/Sub. Uma única atualização de estado de sala era, na prática, três ou quatro comandos: gravar a fase, gravar o mapa, gravar o tempo restante e publicar o aviso para o proxy.

Escrito do jeito ingênuo, cada comando seria uma ida e volta completa: manda, espera a resposta, manda o próximo. Multiplique isso por todas as salas e por todo evento de jogador, e o tempo gasto esperando resposta cresce rápido, justamente nos momentos de mais movimento.

## Por que não era trivial

Quase todo o custo de um comando Redis simples é a viagem, não o processamento. O Redis responde um `HSET` em microssegundos. O que pesa é o ciclo de mandar, esperar o pacote voltar e só então mandar o próximo, além das chamadas de sistema de cada lado. Mesmo com o Redis na mesma máquina, isso se acumula quando a conta é por milhares de comandos.

O segundo problema era concorrência. Tirar todo I/O da thread principal do jogo tem uma consequência que o desenho precisava absorver: várias threads assíncronas pedem conexão ao mesmo tempo. Uma conexão Jedis não pode ser compartilhada entre threads, então cada uma precisa da sua. Com poucas conexões disponíveis, as tarefas fariam fila exatamente nos picos, e a fila viraria atraso em tudo: no aviso ao proxy, na atualização da conta, no registro do jogador.

E havia a assinatura do Pub/Sub, que ocupa uma conexão inteira enquanto está ativa e não pode ser usada para mais nada.

## A solução

### Pipeline: mandar tudo e esperar uma vez

O Jedis, cliente Redis que eu usava em Java, permite abrir um pipeline: enfileiro vários comandos no cliente, mando todos de uma vez e leio as respostas no fim. Para o servidor Redis não muda nada, ele executa os comandos na ordem em que chegaram. Para mim, quatro esperas viram uma.

O detalhe que importa é a ordem. Como o aviso Pub/Sub vai no fim do mesmo pipeline, quem recebe o aviso e corre para ler o hash já encontra os valores novos gravados. Não existe a janela em que o proxy é avisado de uma mudança que ainda não está no Redis.

Apliquei o mesmo padrão em todo lugar em que havia "grava e avisa": registro de servidor ao subir, entrada e saída de jogador, mudança de whitelist, atualização de campo da conta, publicação de report.

### Pool dimensionado para o modelo de concorrência

As conexões saem de um `JedisPool` com até 128 conexões. Cada tarefa assíncrona pega uma conexão num `try-with-resources`, usa por alguns milissegundos e devolve. Como as operações são curtas e o número de threads simultâneas nos picos é alto, um teto folgado evita que alguém espere conexão livre. Conexão parada no pool custa pouca memória, e conexão faltando custa latência em cascata.

### Assinatura em conexão dedicada

O ouvinte de Pub/Sub roda numa tarefa assíncrona própria, que pega uma conexão e fica com ela. Se a assinatura cai por erro, o código cancela e se inscreve de novo, em vez de deixar o processo surdo para os avisos da rede sem ninguém perceber.

## Um exemplo

Uma versão simplificada da atualização de estado de uma sala:

```java
void publishMatchState(String serverId, MatchState state) {
    String key = "server:" + serverId;
    try (Jedis redis = pool.getResource()) {
        Pipeline pipe = redis.pipelined();
        pipe.hset(key, "phase", state.phase().name());
        pipe.hset(key, "map", state.mapName());
        pipe.hset(key, "secondsLeft", String.valueOf(state.secondsLeft()));
        // o aviso vai por último: quem recebe já encontra o hash atualizado
        pipe.publish("server-updates", serverId + ":UPDATE");
        pipe.sync();
    }
}
```

A diferença numa linha do tempo, com tempos ilustrativos de uma viagem de 0,3 ms:

| Sem pipeline | Com pipeline |
| --- | --- |
| t=0,0 ms envia `HSET phase` e espera | t=0,0 ms envia os quatro comandos |
| t=0,3 ms resposta, envia `HSET map` e espera | t=0,3 ms chegam as quatro respostas |
| t=0,6 ms resposta, envia `HSET secondsLeft` e espera | conexão volta ao pool |
| t=0,9 ms resposta, envia `PUBLISH` e espera | |
| t=1,2 ms resposta, conexão volta ao pool | |

Um milissegundo parece pouco, até multiplicar por cada evento de cada sala num fim de partida simultâneo. E o ganho que mais importa não é o tempo de uma tarefa, é o tempo que a conexão fica presa. Com pipeline, cada tarefa devolve a conexão ao pool quatro vezes mais rápido, o que reduz a disputa por conexão justamente no pico.

## Resultado

Cada par "grava o estado e avisa a rede" passou a custar uma ida e volta em vez de várias, com a garantia de ordem entre a escrita e o aviso. Com o pool dimensionado para as threads assíncronas, as tarefas de I/O não faziam fila esperando conexão nos picos. Não guardei medições de antes e depois, então não cito ganho em milissegundos de produção. O que posso afirmar é o mecanismo e a ordem garantida.

## O que eu levo disso

Quando um estado precisa ser gravado e anunciado, os dois vão no mesmo lote, com o anúncio por último. Isso resolve desempenho e consistência ao mesmo tempo. E um pool de conexões deve ser dimensionado a partir de quantas threads realmente pedem conexão ao mesmo tempo, não de um número padrão copiado da documentação. Hoje, com outras ferramentas, sigo o mesmo princípio: agrupar o que vai para o mesmo destino e nunca deixar um recurso compartilhado virar a fila escondida do sistema.
