---
title: Git desde o primeiro plugin, num servidor de Minecraft caseiro
summary: "Meus plugins compartilhavam classes e configurações, e o único ambiente que eu tinha era o próprio servidor. Adotei Git desde cedo para saber o que mudou em cada versão e voltar atrás em segundos."
project: schannetwork
order: 4
tags: [Git, Controle de versão, Java, Produção]
---

Imagine um sábado à noite, servidor cheio, e a vontade de "só ajustar uma coisinha" no plugin de kits. Edita o arquivo, recompila, reinicia. O plugin de kits passa a funcionar como você queria, e o de combate, que lia a mesma configuração, para de funcionar. Sem saber exatamente o que mudou e sem cópia da versão de ontem, a única saída seria desfazer de cabeça. Era esse o risco que eu enxergava no meu jeito de trabalhar quando era um adolescente com um servidor no PC de casa, e foi por causa dele que aprendi, cedo, para que serve controle de versão.

## O problema

Os meus plugins começaram pequenos e foram crescendo. Com o tempo, uma alteração em um lugar podia afetar outro, porque eles compartilhavam classes e configurações. O servidor tinha jogadores de verdade conectados, e o único ambiente onde eu conseguia testar era ele mesmo.

Sem histórico, eu não teria como saber o que tinha mudado nem como voltar para o estado que funcionava. O "estado que funcionava" só existiria na minha memória, que é uma ótima ferramenta para muita coisa e uma péssima ferramenta para guardar código.

## Por que não era trivial

Sem histórico, não há como comparar a versão boa com a quebrada. E eu editava os arquivos direto na máquina onde o servidor rodava, então não havia nenhum intervalo entre ter uma ideia e ela estar na frente dos jogadores. Um erro de digitação ia ao ar junto com a correção.

Aprender Git sozinho também tem curva. Repositório, commit, branch, área de preparação: nenhum desses conceitos é óbvio na primeira vez, e quase todo material da época assumia que você já trabalhava num time, com servidor de código e revisão. Eu era um time de uma pessoa só, com um PC em casa.

## A solução

Comecei a versionar tudo com Git, e as regras que adotei foram poucas e simples.

### Um commit por mudança, com mensagem que explica

Cada alteração virava um commit com uma frase dizendo o que mudou. Parece burocracia até o dia em que algo quebra e o histórico responde sozinho "o que eu mexi por último?".

### Voltar uma versão em vez de consertar no susto

Se uma mudança não se comportasse como eu esperava, eu voltava para o último estado bom em segundos e investigava com calma. Errar ficou barato.

### O servidor deixou de ser o lugar onde se mexe

O código passou a ser editado e testado fora da máquina onde o servidor rodava. O servidor recebia só o que já estava commitado. Isso criou o intervalo que faltava entre a ideia e os jogadores.

## Um exemplo

A sequência abaixo é **ilustrativa**, com nomes e mensagens plausíveis, mostrando o fluxo que resolveria a cena do sábado à noite:

```bash
git init
git add .
git commit -m "Primeira versão dos plugins de kits e combate"

# dias depois, a tal "coisinha"
git commit -am "Kits: aumentar sopas do kit inicial e mudar cooldown"

# o combate para de aplicar dano
git log --oneline
# a3f9c21 Kits: aumentar sopas do kit inicial e mudar cooldown
# 7b1e044 Combate: corrigir knockback no modo HG
# 2c88d10 Primeira versão dos plugins de kits e combate

git diff 7b1e044 a3f9c21    # mostra exatamente o que mudou
git revert a3f9c21          # desfaz a mudança, mantendo o histórico
```

Em vez de tentar lembrar o que tinha mexido, o `git log` mostra a última mudança e o `git diff` mostra a linha responsável. No exemplo, ao mudar o cooldown, a alteração caiu numa configuração compartilhada que o plugin de combate também lia.

A diferença, contada em tempo:

| Situação | Sem Git | Com Git |
| --- | --- | --- |
| Descobrir o que mudou | Lembrar de cabeça, com pressa | `git log` e `git diff`, segundos |
| Voltar ao estado bom | Desfazer na mão e torcer | `git revert`, segundos |
| Investigar a causa | Com pressa, no servidor | Com o servidor de pé, sem pressa |
| Entender uma decisão meses depois | Impossível | Ler a mensagem do commit |

O `revert` cria um commit novo que desfaz o anterior, em vez de apagar a história. Para mim isso importava: eu queria lembrar que aquela mudança tinha dado problema, para não repetir o mesmo caminho na semana seguinte.

## Resultado

Toda versão que ia para o servidor passou a ter um histórico, e voltar para a anterior levava segundos. O ganho maior foi psicológico: com um histórico confiável, mexer no código deixou de ser assustador, porque desfazer era barato. Isso me deixou mais ousado nas mudanças e mais cuidadoso nas entregas ao mesmo tempo.

Também aprendi o valor de um histórico limpo. Mensagem do tipo "ajustes" ou "teste" não serve para nada daqui a um mês. Mensagem que diz o que mudou e por quê é documentação de graça.

## O que eu levo disso

Versionar desde a primeira linha, mesmo em projeto pequeno e de uma pessoa só. O custo no começo é quase zero, e o dia em que uma mudança se comporta mal é exatamente o dia em que o histórico paga a conta inteira.

E separar o lugar onde se mexe do lugar onde as pessoas usam. Eu aprendi isso num servidor caseiro. Hoje esse mesmo princípio aparece em ambientes de homologação, revisão de código e deploy, mas a raiz é a mesma: produção não é lugar de experimento.
