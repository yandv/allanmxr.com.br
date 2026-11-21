---
title: Gerar os mapas às 3 da manhã para o pico das 9 da noite ficar só com o jogo
summary: "Com a rede inteira numa única máquina, gerar um mapa novo no horário de pico roubaria CPU de todos os modos de jogo. Passei a gerar um estoque de mapas de madrugada e a rotacionar entre eles durante o dia, sem comprar outro servidor."
project: saintmc
order: 8
tags: [TerrainControl, Processamento em lote, CPU, Minecraft, Operação]
---

Imagine nove da noite, pico da rede. Uma partida de Hardcore Games termina e a sala precisa de um mundo novo para a próxima. Se o servidor começasse a gerar terreno, biomas e cavernas do zero naquele momento, em segundos um jogador no lobby veria o chat atrasar e outro no KitPvP sentiria um golpe chegar de longe. Nenhum deles estaria no Hardcore Games. Todos estariam na mesma máquina.

## O problema

O Hardcore Games é um modo em que cada partida começa num mapa novo, gerado aleatoriamente: ninguém pode conhecer o terreno de antemão, e explorar faz parte do jogo. No SaintMC, quem gerava esses mapas era o TerrainControl, um plugin que cria o mundo a partir de regras de relevo, bioma e estruturas.

Gerar um mundo é trabalho pesado de CPU. E o SaintMC rodava numa única máquina dedicada, administrada na mão por mim, com o proxy, os lobbies e todas as salas dividindo o mesmo processador. Uma sala gerando mapa não rouba CPU só de si mesma: rouba de todos. O sintoma apareceria nos lugares mais distantes da causa.

## Por que não era trivial

Não havia outra máquina para onde mandar o trabalho. Não havia nuvem com instâncias sob demanda, nem fila de jobs em outro servidor. Era uma máquina só.

O gerador era de terceiros e fazia exatamente o que eu queria que fizesse. Reescrever um gerador de mundo para ser mais leve não era uma opção realista. E diminuir o número de partidas estava fora de questão, porque o Hardcore Games era o modo principal da rede.

À primeira vista, o problema pedia mais hardware. Mas o processador não estava faltando o dia inteiro. Estava faltando em momentos específicos, justamente quando todo mundo estava online.

## A solução

### Trocar a pergunta

A pergunta deixou de ser "como gerar o mapa mais rápido" e virou "por que gerar o mapa justamente quando alguém está jogando". O mapa de uma partida não precisa existir só a partir do momento em que a partida é pedida. Ele pode ser feito antes e guardado.

### Gerar em lote de madrugada

A geração passou a acontecer entre 3h e 5h da manhã, quando a rede ficava quase vazia e a CPU estava sobrando. Nessa janela, a máquina produzia um estoque de mapas prontos. Fora dela, nenhum mapa novo era gerado.

### Rotacionar entre mapas prontos durante o dia

O servidor de Hardcore Games passou a rotacionar entre 50 e 100 mapas já gerados. Cada partida nova só precisava pegar um mundo do estoque e carregá-lo, o que é rápido e barato perto de criar terreno do zero. Ao fim da partida, o mundo usado era descarregado e a sala seguia para o próximo da rotação. A madrugada seguinte renovava o conjunto.

Ter dezenas de mapas prontos também deu um bônus de produto: variedade. O jogador não percebia repetição, porque a rotação tinha de onde escolher.

## Um exemplo

Não tenho o código dessa rotina para mostrar, então o trecho abaixo é ilustrativo: a forma da ideia, não a implementação original.

```java
public final class MapStock {

    private static final int TARGET_STOCK = 80;
    private final Deque<Path> ready = new ArrayDeque<>();

    /** Roda só na janela de madrugada, quando a CPU está ociosa. */
    public void refill(MapGenerator generator) {
        while (ready.size() < TARGET_STOCK && isOffPeakWindow(LocalTime.now())) {
            ready.add(generator.generateNewWorld());
        }
    }

    /** Chamado a cada partida nova, no horário de pico: só escolhe, nunca gera. */
    public Path takeForNextMatch() {
        Path map = ready.poll();
        if (map == null) throw new IllegalStateException("Estoque de mapas vazio");
        return map;
    }

    private boolean isOffPeakWindow(LocalTime now) {
        return !now.isBefore(LocalTime.of(3, 0)) && now.isBefore(LocalTime.of(5, 0));
    }
}
```

E a diferença num dia típico, com horários ilustrativos:

| Horário | Gerando sob demanda | Com estoque pronto |
| --- | --- | --- |
| 03:00 a 05:00 | máquina ociosa | estoque de mapas sendo reposto |
| 14:00, partida termina | gera mapa, CPU no limite por alguns segundos | pega mapa pronto, carrega |
| 21:00, pico | cada nova partida gera mapa, lag na rede inteira | cada nova partida pega mapa pronto |
| 21:05, lobby e KitPvP | sentem o lag da geração | nem percebem que houve troca de mapa |

O trabalho total de CPU no dia é praticamente o mesmo. O que mudou foi quando ele acontece. Saiu do horário em que todo mundo estava jogando e foi para o horário em que quase ninguém estava.

## Resultado

A geração de mapas deixou de disputar CPU com o jogo. Durante o dia, a CPU ficou disponível para o que importava, que era o jogo, e o trabalho pesado passou a acontecer escondido na madrugada, sem ninguém para prejudicar. Não precisei comprar outra máquina para resolver um problema que, no fundo, era de agendamento.

## O que eu levo disso

Nem todo trabalho precisa acontecer no momento do pedido. Se o resultado pode ser calculado antes e guardado, o horário de pico deixa de pagar por ele. Eu já tinha esbarrado nessa lição no meu primeiro servidor, o SchanNetwork; no SaintMC ela virou rotina. Hoje aplico a mesma ideia em pré-processamento, cache aquecido e jobs em lote: antes de otimizar um trabalho pesado, pergunto se ele precisa mesmo acontecer agora.
