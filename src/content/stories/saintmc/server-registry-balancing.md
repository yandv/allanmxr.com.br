---
title: Encher uma sala antes de abrir outra, sem orquestrador
summary: "Distribuir jogadores igualmente entre salas deixaria todas abaixo do mínimo, e a partida não começaria. Fiz cada sala se registrar sozinha e o proxy encher uma antes de abrir outra, sem lista de servidores mantida à mão."
project: saintmc
order: 3
tags: [Redis, Pub/Sub, Balanceamento de carga, Service discovery, BungeeCord]
---

Quarenta jogadores clicam em "Hardcore Games" no lobby quase ao mesmo tempo. Se o proxy espalhar essa turma de forma uniforme entre quatro salas, cada uma fica com dez pessoas, nenhuma atinge o mínimo para começar e todo mundo fica olhando o contador parado. Em dois minutos metade desiste e volta para o lobby. O que o jogador quer é o contrário: uma sala enchendo rápido e a partida começando.

## O problema

A rede tinha lobbies, servidor de login e várias salas de partida, cada uma um processo Java separado. Salas subiam quando eu precisava de mais capacidade e desciam para manutenção ou atualização. O proxy BungeeCord, que recebe todas as conexões e decide em qual servidor o jogador vai parar, precisava saber a cada instante:

- quais servidores existem e de que tipo são;
- quantos jogadores cada um tem e quantos cabem;
- em que fase está a partida e se ainda aceita gente.

Com isso, ele precisava decidir para onde mandar cada jogador sem que eu editasse um arquivo de configuração a cada sala nova.

## Por que não era trivial

Não existia orquestrador nem descoberta de serviço pronta. Era uma máquina dedicada, administrada na mão, com processos que eu mesmo iniciava. A lista de servidores tinha que se montar sozinha.

E a regra de escolha não podia ser única. Espalhar jogadores é ótimo num lobby, onde o objetivo é dividir a carga. Espalhar jogadores em salas de partida é péssimo, pelo motivo da cena acima. Um balanceador genérico de "menos conexões" resolveria um caso e quebraria o outro.

## A solução

### Cada servidor se apresenta sozinho

Ao subir, o servidor grava no Redis um hash com seus dados (tipo, vagas, se aceita entrada, endereço) e adiciona o próprio id ao conjunto do seu tipo. Na mesma viagem de rede, limpa os dados da execução anterior e avisa a rede de que nasceu. Um proxy que sobe depois lê esse estado direto do Redis, então não depende de ter ouvido mensagens antigas.

### Mudanças viajam por Pub/Sub

Um canal Pub/Sub do Redis carrega eventos tipados: servidor iniciou, parou, jogador entrou, jogador saiu, entrada liberada, e atualizações da partida (fase, mapa, tempo restante). O proxy assina o canal e mantém em memória o mapa de servidores ativos. Quando uma sala para, o evento de parada a tira da lista na hora.

### Uma estratégia de escolha por tipo de sala

O proxy associa um balanceador a cada tipo de servidor:

- **Menor ocupação** para lobbies e login, onde o objetivo é dividir a carga.
- **Maior ocupação** para salas de partida, para encher uma antes de abrir outra.
- **Rodízio** (round robin) disponível para os casos em que a distribuição uniforme importa mais que a ocupação.

Todos respeitam a mesma pergunta feita ao servidor: "você pode ser escolhido agora?". Uma sala cheia diz não. Uma sala de Hardcore Games com a partida em andamento diz não. E uma sala na contagem regressiva só diz sim enquanto faltam pelo menos 15 segundos para começar, para ninguém cair numa partida que vai iniciar antes de o mundo carregar.

O resto do proxy só pede "o próximo servidor deste tipo". O comando de ir ao lobby, a reconexão depois de uma queda e o botão de entrar numa partida usam o mesmo ponto.

## Um exemplo

Uma versão simplificada da estratégia de maior ocupação e da regra de elegibilidade de uma sala:

```java
class MostPlayers<T extends GameServer> implements Balancer<T> {
    public T next(Collection<T> servers) {
        T best = null;
        for (T server : servers) {
            if (!server.canBeSelected()) continue;
            if (best == null || server.online() > best.online()) best = server;
        }
        return best; // null: nenhuma sala disponível, o proxy avisa o jogador
    }
}

class MatchServer extends GameServer {
    @Override
    boolean canBeSelected() {
        if (isFull() || state == State.IN_PROGRESS) return false;
        // na contagem regressiva, só aceita se ainda dá tempo de carregar
        return state == State.WAITING
            || (state == State.COUNTDOWN && secondsToStart >= 15);
    }
}
```

E a decisão do proxy para cinco jogadores chegando em sequência, com valores fictícios:

| Jogador | Sala A | Sala B | Sala C | Escolha | Motivo |
| --- | --- | --- | --- | --- | --- |
| 1 | 18/24, esperando | 6/24, esperando | em andamento | A | mais cheia elegível |
| 2 | 19/24 | 6/24 | em andamento | A | mais cheia elegível |
| 3 | 20/24, contagem 40 s | 6/24 | em andamento | A | ainda faltam 40 s |
| 4 | 21/24, contagem 12 s | 6/24 | em andamento | B | A começa em menos de 15 s |
| 5 | 21/24, contagem 9 s | 7/24 | em andamento | B | B passa a ser a mais cheia |

A sala C nunca aparece como opção porque a partida já começou. A sala B, que estava quase vazia, só começa a receber gente quando a A deixa de ser elegível. Num lobby, a mesma sequência daria o resultado oposto: cada jogador iria para o servidor mais vazio.

## Resultado

Subir uma sala nova virou só iniciar o processo. Ela se registrava, o proxy passava a considerá-la e os jogadores começavam a chegar. Desligar uma sala era emitir o evento de parada. Não existia lista de servidores mantida na mão no proxy, e eu podia subir ou derrubar salas no meio do dia sem reiniciar nada na frente.

Do lado do jogador, as partidas começavam mais rápido porque a fila se concentrava, e ninguém caía numa sala já em andamento ou prestes a começar sem tempo de carregar.

## O que eu levo disso

A política de escolha é decisão de produto, não de infraestrutura. "Para onde mandar o jogador" depende do que ele vai fazer lá. Separar a estratégia da lista de candidatos custou poucas linhas e me deixou trocar o comportamento de um modo de jogo sem tocar nos outros. E colocar a regra de elegibilidade no próprio servidor, que conhece a fase da partida, foi mais simples do que ensinar o proxy sobre cada modo. É o mesmo raciocínio que aplico hoje quando desenho filas, roteamento ou distribuição de trabalho: a pergunta certa vem antes do algoritmo.
