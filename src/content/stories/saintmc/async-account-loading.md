---
title: Tirar o banco do tick e carregar a conta antes do jogador entrar
summary: "Ler a conta do banco dentro do tick do Minecraft faria a sala inteira engasgar sempre que muitos jogadores entrassem juntos. Desenhei o carregamento para acontecer antes de o jogador entrar no mundo, e o jogo nunca espera pelo banco."
project: saintmc
order: 1
tags: [Java, Bukkit, BungeeCord, MongoDB, Redis, Concorrência]
---

Imagine um sábado à noite, lobby de Hardcore Games lotado, uma partida prestes a começar. Um grupo de jogadores entra de uma vez e, por meio segundo, todo mundo que já estava na sala vê os outros "teleportando", as flechas param no ar e o chat congela. Ninguém fez nada de errado. Bastaria o servidor esperar o banco responder a conta de quem acabou de chegar.

## O problema

Um servidor de Minecraft roda em ciclos fixos, os ticks: vinte por segundo, um a cada 50 ms. Em cada tick ele move entidades, processa golpes, atualiza o mundo e envia o resultado aos jogadores. Se algo dentro do tick demora 200 ms, aquele tick dura 200 ms e os três seguintes simplesmente não acontecem no tempo certo. O jogador percebe isso como lag.

No SaintMC, a conta do jogador (grupo, moedas, punições, clã, preferências) vinha do MongoDB, com o Redis como cache na frente. Qualquer leitura feita na thread principal, mesmo uma que levasse só algumas dezenas de milissegundos, roubaria tempo do tick. Com muita gente entrando junto, como na virada de uma partida, essas esperas se somariam e a sala inteira pagaria a conta, não só quem estava chegando. Era essa restrição da plataforma que o desenho precisava respeitar.

## Por que não era trivial

A resposta óbvia seria "joga a consulta para outra thread". O problema é que a API do Bukkit não é thread safe: quase tudo que mexe em jogador, mundo ou inventário precisa rodar na thread principal. Se eu buscasse a conta em paralelo e o jogador já estivesse no mundo, ia ter um intervalo em que ele existe sem conta carregada. Nesse intervalo, um comando, o tablist ou o chat pediriam o grupo dele e não encontrariam nada.

Havia ainda um problema de disciplina. A conta é lida em vários pontos: ao entrar, ao trocar de servidor, ao consultar outro jogador por nome. Bastaria uma leitura síncrona esquecida em qualquer canto para o tick engasgar. Eu precisava de um desenho em que o caminho certo fosse também o caminho mais fácil.

## A solução

### Achar o momento em que esperar é barato

O Bukkit tem um evento pensado exatamente para isso: o `AsyncPlayerPreLoginEvent`. Ele dispara numa thread separada, depois que o cliente se autentica e antes de o jogador existir no mundo. Ali eu posso demorar o que precisar sem atrasar nenhum tick, porque o jogador ainda está na tela de "Conectando...", onde algumas centenas de milissegundos passam despercebidas.

Coloquei todo o carregamento da conta nesse evento. Primeiro as recusas baratas (manutenção, endereço inválido, conta já online em outra sessão), depois a busca da conta em memória, Redis e Mongo, e por fim o clã, se o jogador tiver um. Se algo falha, o jogador é recusado na porta com uma mensagem clara, em vez de entrar num estado pela metade.

### Garantir que não sobra lixo

Outro plugin pode recusar o login depois de mim. Para cobrir esse caso, um segundo handler, com prioridade `MONITOR` (a última a rodar), confere o resultado final do evento e descarta a conta da memória se o login não foi aceito.

### Fazer o mesmo no proxy

No BungeeCord, o proxy que fica na frente de todos os servidores, o raciocínio foi o mesmo. O evento de login do proxy tem o mecanismo de "intent": eu registro uma intenção, faço o trabalho numa thread assíncrona e libero a conexão quando termino. O proxy segura o jogador sem bloquear a thread de rede.

### Escritas também fora do tick

Para gravar, a regra foi simétrica. Uma alteração de campo atualiza a conta em memória na hora e manda a gravação no Mongo, a atualização do Redis e o aviso aos outros servidores para uma tarefa assíncrona. O núcleo compartilhado chamava um `runAsync` exposto pela plataforma, sem saber se estava rodando no Bukkit ou no BungeeCord.

## Um exemplo

O código abaixo é uma versão simplificada e com nomes genéricos do listener, só para mostrar a forma:

```java
public class AccountLoginListener implements Listener {

    private final AccountRepository repository;
    private final Map<UUID, Account> online = new ConcurrentHashMap<>();

    @EventHandler(priority = EventPriority.LOW)
    public void onPreLogin(AsyncPlayerPreLoginEvent event) {
        // roda fora da thread principal: pode esperar o banco à vontade
        Account account = repository.load(event.getUniqueId());
        if (account == null) {
            event.disallow(Result.KICK_OTHER, "Não foi possível carregar sua conta.");
            return;
        }
        online.put(event.getUniqueId(), account);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPreLoginResult(AsyncPlayerPreLoginEvent event) {
        // outro plugin pode ter recusado depois de nós
        if (event.getLoginResult() != Result.ALLOWED) {
            online.remove(event.getUniqueId());
        }
    }

    public Account get(UUID id) {
        return online.get(id); // na thread principal, só leitura de mapa
    }
}
```

A diferença aparece melhor numa linha do tempo. Se a leitura ficasse dentro do tick:

| Tempo | O que acontece |
| --- | --- |
| t=0 ms | Tick começa, jogador novo entra no mundo |
| t=5 ms | Código pede a conta, cache vazio, vai ao Mongo |
| t=180 ms | Mongo responde, tick termina |
| t=180 ms | Três ticks perdidos, a sala inteira sente |

Com o pré-login:

| Tempo | O que acontece |
| --- | --- |
| t=0 ms | Cliente autenticado, pré-login dispara em outra thread |
| t=180 ms | Conta carregada em memória, login liberado |
| t=181 ms | Jogador entra no mundo, a conta já está lá |
| sempre | Ticks seguem a cada 50 ms, ninguém percebe nada |

Os 180 ms continuam existindo. Eles só mudaram de lugar: saíram do ciclo que todo mundo compartilha e foram para a tela de conexão de quem está chegando.

## Resultado

O tick do jogo não espera por banco no caminho de entrada. Dentro da partida, ler a conta virou uma consulta a um mapa em memória, e o resto do código podia confiar que, se o jogador existe no mundo, a conta dele existe também. Isso eliminou uma classe inteira de checagens de nulo espalhadas pelos modos de jogo.

Não guardei medições de latência da época, então não vou inventar números. O que dá para afirmar é o mecanismo: o custo de ir ao banco passou a ser pago uma vez por conexão, na tela de carregamento, e não mais no meio de uma luta.

## O que eu levo disso

Antes de otimizar uma consulta, eu pergunto em que momento ela precisa acontecer. Quase todo sistema tem um ponto do ciclo de vida em que esperar é barato: o pré-login de um jogo, o build de uma página, o job que roda antes do usuário pedir. Mover o I/O para esse ponto costuma render mais do que qualquer índice novo. E desenhar o fluxo para que o jeito certo seja também o mais fácil vale mais do que contar com a disciplina de todo mundo.
