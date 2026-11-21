---
title: Barrar bots na porta do proxy, do filtro mais barato ao mais caro
summary: "Ondas de bots lotavam o servidor e o chat antes de serem expulsas, gastando recursos do jogo. Coloquei filtros na entrada, do mais barato ao mais caro, que barram esses ataques sem atrapalhar quem joga com conta original."
project: saintmc
order: 5
tags: [BungeeCord, Rate limiting, Proteção contra bots, Guava Cache, Java]
---

Dez da noite, o contador de jogadores dá um salto de dezenas em menos de um minuto. Não é campeonato nem vídeo novo de youtuber. São contas com nomes aleatórios, todas saindo do mesmo punhado de endereços, entrando e saindo sem parar. Cada uma que passa da porta carrega uma conta, ocupa um slot e entra num lobby. Os jogadores de verdade começam a ver "servidor cheio" e o chat vira spam.

## O problema

Uma rede de Minecraft aberta é alvo fácil de bots: programas que abrem conexões em massa, cada uma com um nick diferente, para lotar o servidor, poluir o chat ou só incomodar. No SaintMC, a rede aceitava contas originais (autenticadas pela Mojang) e também contas não originais, o que é comum em servidores brasileiros e aumenta muito o espaço para abuso.

Quanto mais fundo uma conexão falsa chegava, mais cara ficava. Barrar no primeiro byte custa quase nada. Barrar depois de carregar a conta, consultar o banco e alocar o jogador num lobby custa tudo isso e mais a expulsão.

## Por que não era trivial

As verificações úteis dependem de serviços externos lentos. Saber se um nick pertence a uma conta original exige perguntar à API da Mojang. Saber de que país vem um IP exige uma API de geolocalização. As duas têm limite de uso. Chamar cada uma a cada tentativa de conexão faria do ataque também um ataque contra essas APIs, e o resultado seria ser bloqueado por elas bem na hora em que mais precisava.

Além disso, o proxy BungeeCord tem uma thread de rede que não pode ficar esperando HTTP. E um jogador legítimo com conexão instável, que cai e volta, não podia ser tratado como bot.

## A solução

Organizei as defesas em camadas, da mais barata para a mais cara, de modo que cada conexão só chegasse a uma verificação cara se tivesse passado por todas as baratas.

### 1. IP bloqueado nem conversa

No evento de conexão do cliente, o primeiro do proxy, o endereço é comparado com um conjunto de IPs bloqueados em memória. Se está lá, a conexão é cancelada antes de qualquer handshake mais pesado.

### 2. Trabalho pesado fora da thread de rede

O pré-login usa o mecanismo de "intent" do BungeeCord: registro a intenção, faço as verificações numa thread assíncrona e libero a conexão no fim. A primeira pergunta é à Mojang, para saber se o nick é de uma conta original. Contas originais já provaram quem são e seguem direto. As demais passam pelos filtros seguintes.

### 3. Uma tentativa por IP a cada poucos segundos

O IP de uma conta não original entra num cache do Guava (biblioteca do Google com um cache em memória que expira entradas sozinho) com validade de cinco segundos. Uma nova tentativa do mesmo IP nesse intervalo é recusada com a mensagem de "muitas tentativas ao mesmo tempo". O cache com expiração faz o papel do rate limit sem nenhuma tarefa de limpeza.

### 4. Muitos nicks no mesmo IP

Cada IP tem um registro com os nicks já vistos. No décimo nome diferente, o IP é bloqueado por um período longo. Esses registros vivem num cache que expira em uma hora, então a memória do proxy não cresce com cada endereço que já passou por ali.

### 5. País fora da área atendida

A geolocalização do IP é consultada uma vez, gravada no banco e mantida em memória. Endereços de países que a rede não atendia eram marcados como não permitidos. Como o resultado fica persistido, o mesmo IP não gasta outra chamada externa nem depois de reiniciar o proxy. Para falso positivo, como um jogador brasileiro viajando, havia um comando da staff para liberar o IP na mão.

### 6. Falhar fechado

Se qualquer verificação lança exceção, a conexão é recusada com uma mensagem e um link para o suporte. Uma falha na API de geolocalização não podia virar porta aberta no meio de um ataque.

## Um exemplo

Uma versão simplificada e com nomes genéricos das camadas 3 e 4:

```java
private final Cache<String, Boolean> recentAttempts = CacheBuilder.newBuilder()
        .expireAfterWrite(5, TimeUnit.SECONDS).build();

private final Cache<String, Set<String>> namesByIp = CacheBuilder.newBuilder()
        .expireAfterWrite(1, TimeUnit.HOURS).build();

Verdict check(String ip, String nickname) throws ExecutionException {
    if (blockedIps.contains(ip)) return Verdict.BLOCKED;

    if (recentAttempts.getIfPresent(ip) != null) return Verdict.TOO_FAST;
    recentAttempts.put(ip, true);

    Set<String> names = namesByIp.get(ip, HashSet::new);
    names.add(nickname.toLowerCase());
    if (names.size() >= 10) {
        blockedIps.add(ip);
        return Verdict.BLOCKED;
    }

    // só chega aqui quem passou pelos filtros em memória
    return geoService.isAllowed(ip) ? Verdict.OK : Verdict.BLOCKED;
}
```

Agora a mesma onda de bots, vinda de um único IP, numa linha do tempo ilustrativa:

| Tempo | Tentativa | Resultado | Custo |
| --- | --- | --- | --- |
| t=0 s | nick 1 | passa, geolocalização consultada e salva | 1 chamada externa |
| t=0,4 s | nick 2 | recusada, muito rápido | lookup em memória |
| t=5,1 s | nick 3 | passa, geolocalização já em memória | lookup em memória |
| ... | nicks 4 a 9 | passam espaçados ou são recusados | lookup em memória |
| t=48 s | nick 10 | IP bloqueado | lookup em memória |
| t=49 s em diante | qualquer nick | cancelado no primeiro evento | quase zero |

Ao longo de toda a onda, a API externa de geolocalização recebeu uma chamada. A Mojang recebeu uma por nick, e só porque essa era a pergunta que decidia se a conta seguia o caminho de original.

## Resultado

Ataques simples de bot passaram a ser barrados na porta, e a rede deixou de gastar conta carregada, slot e lobby com eles. As APIs externas recebiam uma chamada por IP novo, não uma por tentativa, o que manteve a rede longe dos limites de uso mesmo durante as ondas. Contas originais nunca passavam pelo funil, então jogador legítimo com conta paga não sentia nada. Não guardei números de tráfego barrado para citar.

## O que eu levo disso

Ordenar filtros pelo custo: tudo que se resolve com um lookup em memória vem antes do que exige rede ou banco. Colocar em cache o resultado de toda consulta externa, com o tempo de vida pensado para o ataque e não para o uso normal. E decidir com antecedência o que acontece quando a própria defesa falha. Hoje, desenhando rate limit em APIs HTTP, sigo a mesma ordem: barato primeiro, caro só para quem passou, e falha fechada.
