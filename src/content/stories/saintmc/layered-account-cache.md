---
title: "O cargo dado no lobby já valendo na partida: cache em três camadas"
summary: "Se cada servidor da rede guardasse uma cópia própria da conta, um jogador promovido no lobby chegaria à partida sem o cargo. Desenhei um cache em camadas em que qualquer mudança aparece em toda a rede quase na hora."
project: saintmc
order: 2
tags: [Redis, Pub/Sub, MongoDB, Cache, Invalidação de cache]
---

Imagine um jogador que compra VIP na loja: alguém da staff aplica o cargo pelo lobby e ele vê a tag colorida aparecer no nome. Feliz, ele clica para entrar numa partida de Hardcore Games. Lá dentro, a tag sumiu e o kit exclusivo está trancado. Ele volta ao lobby, a tag está lá. Na cabeça dele, pagou e o servidor está quebrado. Bastaria a partida estar olhando para uma cópia antiga da conta. Esse era o cenário que o desenho da camada de dados precisava tornar impossível.

## O problema

No SaintMC, o mesmo jogador passava por vários processos Java ao longo de uma sessão: o proxy BungeeCord na frente, um lobby, uma sala de partida, outro lobby. Todos precisavam ler a conta dele (grupo, moedas, punições, clã, preferências) o tempo inteiro, para montar o tablist, liberar kits, filtrar o chat.

Eu tinha duas saídas ruins. Se cada processo fosse ao MongoDB a cada leitura, o banco virava gargalo e cada consulta disputava tempo com o jogo. Se cada processo guardasse a própria cópia sem avisar os outros, a leitura ficava barata, mas uma mudança feita em um lugar não chegava aos demais. É exatamente o caso da tag que some.

## Por que não era trivial

Cache é fácil, invalidação não. Eu precisava de três garantias ao mesmo tempo:

1. **Leitura barata.** A maior parte das leituras não podia sair do processo.
2. **Mudança visível em toda a rede em pouco tempo.** Sem esperar o jogador reconectar.
3. **Memória sob controle.** O Redis não podia acumular para sempre a conta de quem jogou uma vez e nunca mais voltou.

E tudo isso numa máquina dedicada que eu administrava na mão, sem serviço gerenciado de cache, sem orquestrador e sem ninguém de plantão além de mim.

## A solução

### Três camadas, da mais barata para a mais cara

A leitura passa por memória local, depois Redis, depois MongoDB, que é a fonte da verdade. No Redis, a conta é um hash (um dicionário de campos dentro de uma chave) com um campo por atributo. Se o hash vem incompleto, eu trato como ausente e deixo o Mongo decidir. Ler uma conta pela metade seria pior do que ir ao banco.

### TTL que acompanha a presença do jogador

Enquanto o jogador está online, a chave dele no Redis não expira. Quando ele sai da rede, aplico um TTL (tempo de vida, depois do qual o Redis apaga a chave sozinho) de cinco minutos. Se ele voltar dentro dessa janela, porque caiu ou trocou de modo, o comando `PERSIST` remove o TTL e a conta continua quente. Se não voltar, o Redis faz a faxina e eu não preciso de nenhuma rotina de limpeza.

### Invalidação que já leva a resposta

Toda alteração de campo grava no Mongo e publica uma mensagem num canal Pub/Sub do Redis (um mecanismo em que quem publica não sabe quem está ouvindo, e todos os assinantes recebem). A mensagem não diz só "a conta mudou". Ela leva o UUID do jogador, o nome do campo, o valor novo e o id do servidor de origem. Quem recebe não precisa reler nada do banco: aplica a mudança direto.

Cada processo assina esse canal e segue três regras. Ignora a mensagem se a origem é ele mesmo, porque a própria alteração já está aplicada. Ignora a mensagem se não tem aquele jogador carregado, porque não há o que atualizar. E, no servidor de jogo, dispara um evento interno de "campo mudou", para os módulos reagirem (o tablist redesenha a tag, o menu de kits libera o item).

Usei o mesmo desenho para clãs e para reports, cada um com o próprio canal.

## Um exemplo

O código abaixo é simplificado e com nomes genéricos. Primeiro, quem altera publica o campo e o valor:

```java
void updateField(Account account, String field, JsonElement value) {
    repository.setField(account.getId(), field, value); // Mongo, fonte da verdade

    JsonObject msg = new JsonObject();
    msg.addProperty("accountId", account.getId().toString());
    msg.addProperty("field", field);
    msg.add("value", value);
    msg.addProperty("source", serverId);

    try (Jedis redis = pool.getResource()) {
        Pipeline pipe = redis.pipelined();
        pipe.hset("account:" + account.getId(), field, value.toString());
        pipe.publish("account-updates", msg.toString());
        pipe.sync();
    }
}
```

E quem assina aplica só o que interessa:

```java
void onAccountUpdate(JsonObject msg) {
    if (serverId.equals(msg.get("source").getAsString())) {
        return; // eco da própria alteração
    }
    Account local = online.get(UUID.fromString(msg.get("accountId").getAsString()));
    if (local == null) {
        return; // este servidor não tem o jogador, nada a fazer
    }
    local.apply(msg.get("field").getAsString(), msg.get("value"));
}
```

Agora a mesma cena do VIP, com o mecanismo funcionando. Os tempos são ilustrativos:

| Tempo | Onde | O que acontece |
| --- | --- | --- |
| t=0 ms | Lobby 1 | Staff aplica o grupo VIP, a cópia local muda na hora |
| t=8 ms | Lobby 1 | Mongo recebe o campo, Redis recebe o hash e a mensagem |
| t=9 ms | Lobby 1 | Recebe a própria mensagem e ignora pela origem |
| t=9 ms | Lobby 2 | Não tem o jogador, ignora |
| t=9 ms | Proxy | Tem o jogador, atualiza o grupo |
| t=4 s | Sala HG 3 | Jogador entra, lê a conta do Redis já com o VIP |

O detalhe do "só se estiver carregada" é o que mantém o custo baixo. O tráfego cresce com o número de alterações, mas o trabalho em cada servidor cresce só com os jogadores que ele realmente tem.

## Resultado

O MongoDB passou a ser consultado só quando a conta não estava em nenhuma camada, o que na prática significava a primeira entrada do dia de cada jogador. Uma promoção, uma punição ou uma troca de clã feita em qualquer processo aparecia nos outros sem consulta extra ao banco, ao custo de uma mensagem pequena por alteração. A tag não tinha como sumir no caminho entre o lobby e a partida.

A conta de quem saiu continuava quente por alguns minutos, o que tornava barata a troca de modo e a reconexão depois de uma queda, e depois desaparecia sozinha do Redis.

## O que eu levo disso

Uma mensagem de invalidação deve carregar o que mudou, e não só o aviso de que algo mudou. Assim ninguém corre ao banco ao mesmo tempo para descobrir a novidade. O campo de origem custa uma linha e evita que o processo reprocesse a própria alteração. E amarrar o TTL ao ciclo de vida real da entidade (online não expira, offline expira) resolve a limpeza sem nenhum job extra. Uso esse mesmo raciocínio hoje sempre que dois processos precisam ver o mesmo dado.
