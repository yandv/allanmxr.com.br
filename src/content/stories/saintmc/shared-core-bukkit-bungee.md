---
title: A mesma regra de punição no proxy e no jogo, escrita uma vez só
summary: "Proxy e servidores de jogo precisam das mesmas regras, e duas cópias de uma regra de mute acabam divergindo até um mute não valer do outro lado. Desenhei um núcleo comum às duas plataformas, e cada regra é escrita uma vez só."
project: saintmc
order: 7
tags: [Arquitetura de software, Java, Maven, BungeeCord, Bukkit]
---

Imagine um moderador aplicando um mute de uma hora pelo proxy. O jogador troca de servidor e continua falando no chat da partida, porque a regra de "está mutado?" do servidor de jogo calculava a expiração de um jeito ligeiramente diferente da regra do proxy. Duas implementações da mesma ideia, escritas em momentos diferentes, divergindo em silêncio. É o tipo de bug que ninguém encontra lendo o código de um lado só, e era exatamente o que eu queria tornar impossível desde o começo.

## O problema

O SaintMC tinha dois tipos de processo que precisavam entender o mesmo domínio. O proxy BungeeCord, que recebe todas as conexões e roteia os jogadores. E os servidores de jogo em Bukkit/Spigot, um para cada lobby e sala. Contas, grupos, punições, clãs, reports, a lista de servidores e o balanceamento eram assunto dos dois.

Escrever tudo duas vezes significava corrigir tudo duas vezes. E, pior, abria espaço para o cenário da abertura: duas versões da mesma regra que divergem sem ninguém perceber até um jogador encontrar a brecha.

## Por que não era trivial

As duas plataformas têm APIs completamente diferentes. No Bukkit, o jogador é um `Player`; no BungeeCord, é um `ProxiedPlayer`. Os agendadores de tarefa são outros, os eventos são outros, os comandos se registram de outro jeito. Se a classe de punição importasse qualquer coisa de uma das plataformas, ela só compilaria para aquela plataforma.

Eu precisava de um corte limpo entre o que é regra da rede e o que é detalhe de plataforma. E esse corte tinha que ser pequeno, senão a "camada de abstração" viraria um segundo framework para manter, maior que o problema que resolvia.

## A solução

### Módulos em camadas

Dividi o projeto Maven em módulos com uma regra simples de dependência: quanto mais embaixo, menos sabe do mundo.

- **Núcleo comum:** zero dependência de Minecraft. Contas, grupos, punições, clãs, reports, o gerenciador de servidores com os balanceadores, o formato das mensagens entre processos e o acesso a dados no MongoDB e no Redis.
- **Ponte para o Bukkit:** listeners, comandos, menus, hologramas, tablist, filtros de pacote e anticheat.
- **Ponte para o BungeeCord:** login, proteção de entrada e comandos de moderação.
- **Modos de jogo:** KitPvP, Hardcore Games, Gladiator, Skywars, lobbies e login, cada um um plugin que depende só da ponte do Bukkit.

### Uma interface de plataforma mínima

O ponto de contato entre o núcleo e a plataforma é uma interface com só o que o domínio realmente precisa pedir para o mundo lá fora: encontrar um jogador por nome ou UUID, falar com o console e executar algo de forma assíncrona. Cada plataforma tem a sua implementação. O núcleo nunca sabe qual está rodando.

Comecei a interface pelo que o domínio precisava, não pelo que as plataformas ofereciam. Se eu tivesse espelhado a API do Bukkit, a interface teria dezenas de métodos e o BungeeCord não conseguiria implementar metade deles.

### Mensagens com o mesmo código dos dois lados

O núcleo também define o formato das mensagens trocadas entre processos: pedidos de punição, alertas, atualizações de servidor. Como as duas pontas serializam e desserializam com a mesma classe, não existe o risco de o proxy esperar um campo que o servidor de jogo parou de mandar.

## Um exemplo

Uma versão simplificada e com nomes genéricos da interface de plataforma e de uma regra do núcleo que a usa:

```java
public interface Platform {
    Optional<UUID> findPlayerId(String name);
    void sendToConsole(String message);
    void runAsync(Runnable task);
}

public final class PunishmentService {
    private final Platform platform;
    private final PunishmentRepository repository;

    public boolean isMuted(Account account, Instant now) {
        // a mesma regra para proxy e jogo: não existe segunda versão para divergir
        return account.mutes().stream().anyMatch(m -> m.isActiveAt(now));
    }

    public void mute(Account target, Duration duration, String reason) {
        Mute mute = Mute.starting(Instant.now(), duration, reason);
        target.addMute(mute);
        platform.runAsync(() -> repository.save(target.getId(), mute));
        platform.sendToConsole("Mute aplicado em " + target.getName());
    }
}
```

No Bukkit, `runAsync` usa o agendador assíncrono do servidor de jogo. No BungeeCord, usa o agendador do proxy. A classe de punição não importa nada de nenhum dos dois e compila sozinha.

E o que mudou, na prática, quando uma regra precisava de ajuste:

| Mudança | Sem núcleo comum | Com núcleo comum |
| --- | --- | --- |
| Novo tipo de punição | implementar no proxy e no jogo | implementar uma vez |
| Corrigir cálculo de expiração | lembrar de corrigir nos dois | uma correção, os dois herdam |
| Novo campo na conta | dois modelos e dois serializadores | um modelo, um serializador |
| Novo modo de jogo | reimplementar conta, grupo, punição | herdar tudo, escrever só o jogo |

## Resultado

Regra de negócio e acesso a dados passaram a ser escritos uma vez. Mudar o formato de uma punição ou de um campo de conta era uma alteração só, vista pelo proxy e pelos servidores de jogo no mesmo deploy. Um mute que escapa ao trocar de servidor não tinha como acontecer, porque só existia uma regra.

O ganho maior apareceu nos modos de jogo. Cada modo novo já nascia com conta, grupo, punição, clã e balanceamento prontos, e eu escrevia só o que era do jogo: as regras da partida, os kits, o placar.

## O que eu levo disso

Uma interface entre o domínio e a infraestrutura deve nascer do que o domínio precisa pedir, e não do que a infraestrutura oferece. Por isso ela ficou com poucos métodos, e por isso foi fácil implementá-la duas vezes. É a mesma ideia que hoje aplico em sistemas web: a regra de negócio não sabe se está rodando num worker, num servidor HTTP ou num job agendado. Ela recebe as poucas capacidades que precisa e deixa o resto para quem está em volta.
