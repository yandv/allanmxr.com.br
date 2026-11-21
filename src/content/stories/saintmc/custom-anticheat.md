---
title: Um anticheat que dava à staff um minuto para discordar
summary: "Trapaças de clique automático e cura instantânea afastavam os bons jogadores, e a staff não estava em todas as salas. Escrevi um anticheat próprio que alerta a staff com contexto e bane sozinho se ninguém discordar em um minuto."
project: saintmc
order: 6
tags: [Anticheat, ProtocolLib, Bukkit, Detecção de fraude, Java]
---

Final de uma partida de KitPvP. Dois jogadores, os dois com pouca vida, trocando golpes. Um deles parece imortal: toda vez que a vida cai, ela volta cheia antes de o golpe seguinte chegar. No chat, o perdedor escreve "autosoup" e sai do servidor. Na rede competitiva, cada cena dessas é um jogador bom a menos, porque ninguém fica onde perde para quem trapaceia.

## O problema

O KitPvP e o Hardcore Games da época giravam em torno de dois recursos: clicar rápido e tomar sopa. No Minecraft daquela versão, a sopa de cogumelo cura na hora, então o jogador habilidoso alterna entre bater e "sopar" o mais rápido possível. Era exatamente isso que as trapaças automatizavam:

- **Autoclick e macro:** programas que clicam por você, numa frequência que ninguém sustenta.
- **Autosoup:** o cliente modificado move a sopa do inventário para a mão e já a consome, sem nenhum intervalo humano.
- **Reach e hitbox:** acertar de mais longe do que o jogo permite, ou ampliar a área do adversário que conta como acerto.
- **Clientes de trapaça completos**, que juntam tudo isso num único programa.

Moderação manual não resolvia. A staff não estava em todas as salas, e quem trapaceava sabia disso. Também não queria depender de um anticheat comercial fechado, que eu não conseguiria ajustar para o ritmo específico do PvP da rede.

## Por que não era trivial

Detectar trapaça é, antes de tudo, um problema de falso positivo. Um jogador com ping alto parece estar batendo de longe. Um jogador muito bom parece usar autoclick. Banir um jogador honesto custa mais caro do que deixar um trapaceiro escapar por mais algumas partidas: ele conta para os amigos, e a confiança na rede cai.

E todos os checks rodam em eventos quentes, como movimento, clique e dano, que disparam dezenas de vezes por segundo por jogador. Qualquer cálculo pesado ali viraria lag para a sala inteira.

## A solução

### Um check por trapaça, pequeno e isolado

Cada tipo de trapaça virou uma classe pequena que escuta só os eventos que precisa medir e dispara um alerta quando passa de um limite. Os checks principais:

- **Autoclick.** Escuta o pacote de animação do braço pelo ProtocolLib (biblioteca que dá acesso aos pacotes de rede do jogo) e conta cliques por segundo. Acima de duas dezenas por segundo, sustentadas, alerta. Ignora quem está com ping alto, em modo criativo ou quebrando bloco, porque nesses casos o clique rápido é legítimo.
- **Macro.** Conta cliques de inventário por segundo, sem contar o shift-click, que é uso normal.
- **Autosoup.** Guarda o instante em que a sopa foi movida para a mão e compara com o instante em que foi consumida, só quando a vida não está cheia.
- **Reach e hitbox.** Calculam a distância entre os olhos do atacante e o alvo e comparam com um alcance máximo que cresce com o ângulo, a velocidade e o desnível. Golpes com ping alto de qualquer lado são descartados. Para hitbox, testam se a linha do olhar do atacante realmente cruza a caixa do alvo.
- **Cliente de trapaça conhecido.** Um cliente popular na época se anunciava num canal de plugin característico. O servidor escutava esse canal e enviava uma mensagem que só o cliente reconhecia. Se o canal respondia, não havia dúvida.

### Alerta com contexto

Cada alerta ia para a staff com permissão e que tinha ligado o anticheat, no formato "jogador está usando X (n de máximo)", com detalhes (cliques por segundo, distância, ping) num texto ao passar o mouse no chat. Os alertas também subiam para o proxy, para a staff em outra sala acompanhar.

### Banimento automático com prazo para intervir

Cada tipo de trapaça tinha um número máximo de alertas e um tempo de punição. Ao atingir o máximo, o jogador entrava numa fila de banimento com contagem regressiva, e a staff recebia avisos durante a contagem para conferir de perto e cancelar se fosse engano. Se o jogador saísse do servidor antes do fim, o banimento era aplicado na hora, para ninguém escapar deslogando. A punição era pedida ao proxy, que a aplicava na rede inteira.

## Um exemplo

O check de autosoup é o mais didático, porque mede uma coisa que nenhum humano consegue fazer. Uma versão simplificada e com nomes genéricos:

```java
public class AutoSoupCheck implements Listener {

    private static final long MIN_HUMAN_INTERVAL_MS = 2;
    private final Map<UUID, Long> soupMovedAt = new HashMap<>();

    @EventHandler
    public void onShiftClickSoup(InventoryClickEvent event) {
        if (event.getAction() != InventoryAction.MOVE_TO_OTHER_INVENTORY) return;
        if (!isSoup(event.getCurrentItem())) return;
        soupMovedAt.put(event.getWhoClicked().getUniqueId(), System.currentTimeMillis());
    }

    @EventHandler
    public void onDrinkSoup(PlayerInteractEvent event) {
        Player player = event.getPlayer();
        if (!isSoup(event.getItem()) || player.getHealth() >= player.getMaxHealth()) return;

        Long movedAt = soupMovedAt.remove(player.getUniqueId());
        if (movedAt == null) return;

        // mover e consumir no mesmo instante só acontece quando um programa faz por você
        if (System.currentTimeMillis() - movedAt <= MIN_HUMAN_INTERVAL_MS) {
            alerts.raise(player, AlertType.AUTOSOUP);
        }
    }
}
```

A diferença entre um jogador rápido e um cliente modificado, com tempos ilustrativos:

| Momento | Jogador habilidoso | Cliente com autosoup |
| --- | --- | --- |
| Move a sopa para a mão | t=0 ms | t=0 ms |
| Troca de slot e mira | t=120 ms | não precisa |
| Consome a sopa | t=180 ms | t=1 ms |
| Resultado do check | nada | alerta |

E o destino de quem acumula alertas:

| Tempo | Evento |
| --- | --- |
| t=0 s | Jogador atinge o máximo de alertas, entra na fila de banimento |
| durante a contagem | Staff recebe avisos com o tempo restante e pode assistir e cancelar |
| fim da contagem | Banimento pedido ao proxy e aplicado na rede inteira |
| se sair antes | Banimento aplicado no momento da saída |

## Resultado

As trapaças mais comuns passaram a ser detectadas e punidas sem depender de alguém da staff estar na sala certa na hora certa. A staff deixou de caçar e passou a revisar: recebia o alerta com contexto, olhava o jogador e decidia, com o banimento automático como padrão se ninguém discordasse. Nem todo check que escrevi ficou ativo na versão final da rede. Não guardei estatística de banimentos nem de falsos positivos para citar.

## O que eu levo disso

Um sistema de detecção sem contexto vira ruído, e ruído faz as pessoas pararem de olhar. Todo alerta precisa dizer o que foi medido e quanto. Automatizar a punição, mas dar a um humano uma janela para discordar, combinou escala com bom senso. Levo isso para qualquer regra antifraude ou de monitoramento: medir uma coisa objetiva, mostrar o número e deixar espaço para revisão.
