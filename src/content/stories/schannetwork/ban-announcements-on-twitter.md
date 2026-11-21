---
title: Cada banimento virava um tweet na @SchanBan
summary: "Jogadores banidos voltavam com outra conta dizendo que foram punidos à toa. Liguei o banimento do servidor ao Twitter para publicar cada punição numa conta pública, na minha primeira integração com uma API externa."
project: schannetwork
order: 3
tags: [Twitter API, OAuth 1.0a, Java, Integração de APIs, Bukkit]
---

Todo servidor de Minecraft tem a mesma cena: um jogador é banido, abre outra conta e vai para o chat jurar que foi injustiça, que a staff persegue, que nunca usou trapaça na vida. Quem joga limpo fica sem saber se a moderação age de verdade. No SchanNetwork eu resolvi isso de um jeito meio ousado para um moleque: cada banimento passou a ser publicado automaticamente numa conta pública do Twitter, a @SchanBan. A moderação saiu de dentro do jogo e foi para a internet.

## O problema

Eu queria transparência sem depender de alguém lembrar de postar. Banir alguém já era um comando dentro do jogo. O que faltava era fazer esse comando avisar o mundo lá fora, sozinho, toda vez.

Na teoria era "só mandar um tweet". Na prática era a minha primeira integração com uma API de terceiros, e eu não sabia nem por onde começar.

## Por que não era trivial

A API do Twitter não aceitava usuário e senha. Ela usava **OAuth 1.0a**, um protocolo em que a aplicação recebe credenciais próprias (um par de chaves do aplicativo e um par de tokens da conta) e **assina** cada requisição com elas. O servidor do Twitter recalcula a assinatura e, se bater, aceita a chamada como se fosse a conta. A senha nunca trafega.

Entender assinatura sem nunca ter feito uma integração foi o primeiro muro. Qualquer detalhe fora do lugar (ordem dos parâmetros, codificação de um caractere, relógio da máquina adiantado) virava um "401 Unauthorized" sem mais explicações.

O segundo muro era mais sutil. Um servidor de Minecraft roda tudo que importa numa thread principal. Se eu chamasse a API dentro do comando de banimento e o Twitter demorasse para responder, o servidor inteiro congelaria esperando um tweet. Ninguém quer lag porque alguém foi banido.

## A solução

### Entender a assinatura antes de usar uma biblioteca

Li a documentação do OAuth até entender o que estava sendo assinado e por quê. Reimplementar criptografia nunca é a ideia, mas saber o que acontece por baixo foi o que me deixou depurar os erros de autenticação em vez de chutar.

### Tirar a chamada do caminho do jogo

O banimento acontece primeiro, na hora, dentro do servidor. A publicação vai para uma tarefa assíncrona, fora da thread principal. Se o Twitter estiver lento ou fora do ar, o jogador continua banido e o servidor continua rodando. O tweet é um complemento, nunca uma condição.

### Guardar credencial como credencial

Foi aqui que caiu a ficha: quem tem essas chaves publica como a conta. Elas não podem ir parar no repositório nem dentro de um `.jar` que circula por aí, e tratar segredo como segredo virou hábito a partir dessa integração.

## Um exemplo

Os nomes e valores abaixo são **ilustrativos**. Primeiro, o que acontece numa chamada assinada com OAuth 1.0a, como linha do tempo:

```text
t=0     staff executa /ban jogador123 "uso de autoclick"
t=1ms   servidor aplica o ban e expulsa o jogador (thread principal)
t=2ms   tarefa assíncrona monta o texto do tweet
t=3ms   gera oauth_nonce (aleatório) e oauth_timestamp (agora, em segundos)
t=4ms   monta a base string: POST & url codificada & parâmetros ordenados
t=5ms   assina com HMAC-SHA1 usando "consumer_secret&token_secret"
t=6ms   envia POST com header Authorization: OAuth ..., oauth_signature=...
t=350ms Twitter recalcula a assinatura, confere nonce e timestamp, publica
```

O `nonce` e o `timestamp` existem para impedir que alguém capture a requisição e a reenvie depois. Por isso um relógio errado na máquina já bastava para derrubar a autenticação, e eu aprendi isso do jeito mais confuso possível.

Agora a parte do jogo, também ilustrativa:

```java
public void ban(Player target, String reason) {
    target.kickPlayer("Você foi banido: " + reason);
    banStorage.save(target.getUniqueId(), reason);

    // o tweet roda fora da thread principal: o Twitter lento não pode travar o servidor
    Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
        try {
            twitter.updateStatus(target.getName() + " foi banido. Motivo: " + reason);
        } catch (Exception e) {
            plugin.getLogger().warning("Falha ao publicar banimento: " + e.getMessage());
        }
    });
}
```

A ordem é a decisão inteira: primeiro a ação que importa, depois o aviso, e a falha do aviso vira uma linha de log, não um servidor parado.

## Resultado

A @SchanBan virou assunto da comunidade. Os jogadores acompanhavam, comentavam e, principalmente, viam que a moderação existia. Fica bem mais difícil dizer "fui banido à toa" quando o motivo está publicado.

Tecnicamente, foi a primeira vez que tratei com autenticação de verdade, credenciais, limites de requisição e um serviço que às vezes responde diferente do que a documentação promete. Aprendi a ler documentação de API com atenção, porque cada detalhe que eu pulava voltava como um 401.

## O que eu levo disso

Integração externa nunca entra no caminho crítico da operação principal. A ação do usuário acontece primeiro, o aviso lá fora vem depois, e a falha do aviso é tratada sem desfazer a ação. Esse padrão aparece em todo sistema que publica eventos, manda e-mail ou chama webhook, e eu aprendi com um bot de banimento.

E entender o protocolo antes de confiar na biblioteca economiza horas. Quando a autenticação falha, quem sabe o que está sendo assinado depura em minutos. Quem não sabe fica trocando configuração no escuro.
