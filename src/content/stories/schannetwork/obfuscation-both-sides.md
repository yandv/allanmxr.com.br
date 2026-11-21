---
title: "Ofuscação dos dois lados: ler código embaralhado e proteger o meu"
summary: "Plugins embaralhados de propósito fechavam meu jeito de aprender, e depois eu mesmo quis proteger os meus contra cópia. Aprendi a ler código ofuscado e a ofuscar o meu, e entendi o que essa proteção segura e onde ela vaza."
project: schannetwork
order: 2
tags: [Java, Ofuscação, Allatori, Bytecode, Engenharia reversa]
---

O meu método de estudo era simples: abrir o `.jar` de um plugin, decompilar e ler. Funcionava muito bem até o dia em que abri um plugin e encontrei classes chamadas `a`, `b` e `c`, métodos chamados `a`, variáveis chamadas `a` e um fluxo que pulava para lugares que não faziam sentido. Era como abrir um livro e descobrir que alguém trocou todas as palavras por "blá". Anos de aprendizado (bom, alguns meses) pareciam ter batido numa parede. Era **ofuscação**, e ela acabou me ensinando mais do que o código limpo.

## O problema

Muitos plugins vinham ofuscados de propósito. O autor queria que ninguém abrisse e copiasse o trabalho dele, o que é justo. Para mim, que aprendia exatamente abrindo e lendo, isso fechava a porta principal.

Tempos depois o problema se inverteu. Eu passei a escrever plugins meus para o SchanNetwork e também não queria que qualquer um abrisse o `.jar`, copiasse e publicasse como se fosse dele. De repente eu estava do outro lado da mesma parede.

## Por que não era trivial

Ofuscar não esconde o código. O `.jar` continua sendo executável, então todo o comportamento continua ali, inteiro. O que a ofuscação tira são as pistas que um humano usa para entender: nomes significativos, estrutura previsível, mensagens legíveis. O mesmo nome curto aparece em várias classes com significados diferentes, e o decompilador às vezes devolve trechos que nem compilam.

Do lado de quem protege, há um custo escondido. Cada transformação mexe no bytecode e pode deixar o plugin maior, mais lento ou simplesmente quebrado. Em plugin de Minecraft isso é bem concreto: o servidor procura algumas coisas pelo nome, como a classe principal declarada no `plugin.yml` e os métodos anotados com `@EventHandler`. Se o ofuscador renomeia a coisa errada, o plugin carrega sem fazer nada, ou nem carrega.

## A solução

### Lendo código ofuscado: partir do que não pode mudar

Sem nomes, passei a ler pelo comportamento. Em vez de perguntar "o que significa esse nome?", eu perguntava "o que isso recebe, o que devolve e com quem conversa?".

A chave foi perceber que as chamadas para a API do Bukkit **não podem ser renomeadas**. O ofuscador só mexe no código do plugin, e o servidor precisa reconhecer `Player`, `sendMessage`, `PlayerJoinEvent`. Essas chamadas viram âncoras. Se um método misterioso chama `setHealth` e recebe um número, já dá para chutar o que ele faz. A partir das âncoras, eu ia renomeando na minha cabeça (e depois num editor) cada peça desconhecida, até o quebra-cabeça fechar.

### Protegendo os meus: Allatori sem caixa-preta

Quando comecei a proteger os meus plugins, usei o Allatori, um ofuscador comercial de Java que roda sobre o `.jar` já compilado. Ele renomeia identificadores, embaralha o fluxo de controle e cifra as strings. Eu não queria usar no modo "aperta o botão e reza". Testava cada transformação, via o que ela fazia com o bytecode e aprendi a configurar exceções: manter a classe principal e os ouvintes de evento com o nome original, porque o servidor precisa enxergá-los.

## Um exemplo

O código abaixo é **ilustrativo**, escrito para mostrar o tipo de transformação, não copiado de nenhum plugin real. Antes da ofuscação, um trecho de combate:

```java
public class CombatListener implements Listener {
    private final Map<UUID, Integer> killStreaks = new HashMap<>();

    private double calculateDamage(Player attacker, double baseDamage) {
        int streak = killStreaks.getOrDefault(attacker.getUniqueId(), 0);
        return baseDamage * (1.0 + streak * 0.05);
    }
}
```

Depois de um ofuscador típico, o decompilador devolveria algo assim:

```java
public class a implements Listener {
    private final Map<UUID, Integer> a = new HashMap<>();

    private double a(Player a, double b) {
        int c = this.a.getOrDefault(a.getUniqueId(), 0);
        return b * (1.0 + c * 0.05);
    }
}
```

Repare no que **sobreviveu**: `Listener`, `Player`, `getUniqueId`, `Map`, `UUID`. Tudo que pertence à API do Bukkit ou ao próprio Java ficou intacto. Para ler, eu fazia exatamente o caminho inverso do ofuscador:

| Pista que sobreviveu | Dedução |
| --- | --- |
| A classe implementa `Listener` | Ouve eventos do jogo |
| O mapa é indexado por `UUID` | Guarda algo por jogador |
| O método recebe `Player` e um `double` e devolve `double` | Transforma um número a partir do jogador |
| `1.0 + c * 0.05` | Bônus de 5% por unidade de algo que vem do mapa |

Quatro linhas de dedução e o `a(Player, double)` vira "calcula dano com bônus por sequência de abates". Quando eu ofuscava os meus plugins, essa tabela era o meu teste: se eu mesmo conseguia reconstruir o sentido em poucos minutos, sabia exatamente o quanto a proteção valia.

## Resultado

Ganhei duas habilidades opostas que se completam. A primeira foi ler código sem depender de nomes bonitos, o que ajuda muito mais do que parece quando se depura sistema legado ou biblioteca sem documentação. A segunda foi usar ofuscação com os olhos abertos, sabendo o custo e o limite de cada transformação.

E ganhei uma noção realista do que ela protege. A ofuscação aumenta o esforço de quem quer copiar, desestimula o curioso casual e pronto. Quem está determinado chega lá, e eu sabia disso porque eu era essa pessoa.

## O que eu levo disso

Ofuscação é uma camada barata, não um cofre. Qualquer segredo de verdade, como uma chave de API ou uma regra que não pode ser burlada, não deve viajar dentro do código que vai para a máquina de outra pessoa. O que precisa ser protegido de fato fica do lado do servidor.

A outra lição é sobre segurança em geral: entender como o ataque funciona é o que permite avaliar a defesa. Eu só soube onde o meu código vazava porque já tinha passado horas extraindo sentido do código dos outros.
