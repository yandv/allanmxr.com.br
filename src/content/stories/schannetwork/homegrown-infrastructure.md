---
title: "Hospedar um servidor no PC de casa: DNS, NAT, firewall e JVM, uma camada por vez"
summary: "Deixar um servidor rodando no PC de casa acessível para quem estava de fora exigia camadas que eu nem sabia que existiam. Aprendi uma por vez, de DNS e NAT ao firewall e à memória da JVM, e cada uma resolveu uma restrição real do ambiente."
project: schannetwork
order: 5
tags: [Linux, DNS, NAT, iptables, JVM, Redes]
---

O servidor do SchanNetwork rodava no PC da minha casa. Eu ligava o servidor, entrava pelo meu próprio jogo, tudo funcionava. Aí um amigo mandava mensagem: "não consigo entrar". Do meu lado estava tudo verde. Do lado dele, tempo esgotado. Esse "funciona aqui, mas ninguém de fora entra" foi o primeiro de muitos mistérios de uma rede doméstica, e cada um me ensinou uma camada que hoje parece óbvia, mas que eu aprendi sozinho, na prática.

## O problema

Ligar o processo do Minecraft é a parte fácil. Para os jogadores entrarem, a máquina precisava ser alcançável pela internet, ter um nome fácil de digitar, não ficar escancarada para qualquer tráfego e continuar de pé quando o número de pessoas aumentava. Ninguém me ensinou nada disso, e uma internet residencial não foi feita para hospedar nada. Cada requisito esbarrava numa restrição diferente do ambiente, e eu tinha que descobrir qual.

## Por que não era trivial

Todas as camadas se escondem atrás do mesmo sintoma. "Ninguém consegue entrar" podia ser o domínio apontando para o lugar errado, o roteador barrando a conexão, o firewall do Linux recusando, o processo do Minecraft morto ou a JVM travada sem memória. Sem entender o que cada camada faz, não há como saber qual falhou. E eu não sabia nem que existiam camadas.

## A solução

Aprendi uma camada por vez, sempre porque um requisito novo pedia.

### Linux

Instalei e administrei o Linux da máquina. Aprendi a ver processos, ler logs, conferir portas abertas e reiniciar o servidor por linha de comando, que é tudo o que você precisa para operar uma máquina sem tela na frente.

### DNS

Um IP é difícil de lembrar e, em internet residencial, pode mudar. O **DNS** traduz um nome para um IP. Configurei um domínio próprio apontando para a máquina, e os jogadores passaram a entrar por um nome em vez de uma sequência de números.

### NAT e port forwarding

Em casa, o roteador tem um IP público e todos os aparelhos ficam atrás dele com IPs privados. O **NAT** (tradução de endereços de rede) é o que faz essa divisão funcionar. O efeito colateral é que uma conexão vinda de fora chega ao roteador e ele não sabe para qual aparelho entregar. O **port forwarding** resolve isso: uma regra no roteador manda o tráfego de uma porta específica para um IP interno. Era exatamente a peça que faltava no mistério do "funciona aqui dentro".

### Firewall com iptables

O **iptables** é o firewall do kernel Linux: uma lista de regras que decide o que entra e o que sai. Uma máquina exposta na internet recebe todo tipo de tentativa de acesso, então a regra de ouro foi liberar só o necessário.

### JVM, memória e Garbage Collection

O servidor de Minecraft é um programa Java, e a JVM gerencia a memória sozinha com o **Garbage Collector**, que recolhe objetos que ninguém usa mais. Dimensionar o processo me obrigou a entender um pedaço de cada vez: quanta memória ele recebe, o que acontece quando ela acaba e por que o servidor congela durante uma coleta grande. Memória deixou de ser um número na caixa do computador e virou algo que eu precisava planejar.

## Um exemplo

Tudo abaixo é **ilustrativo**, com IPs de documentação e valores genéricos, não a configuração real da época. O caminho de uma conexão de jogador:

```text
jogador digita play.exemplo.com.br
  -> DNS responde 203.0.113.45 (IP público do roteador de casa)
  -> conexão chega ao roteador na porta 25565
  -> port forwarding: 25565 -> 192.168.0.10:25565 (o PC do servidor)
  -> iptables no PC aceita a porta 25565
  -> processo Java do Minecraft recebe o jogador
```

Cada seta é um lugar onde a conexão pode morrer. O mistério do amigo que não entrava era a terceira seta: sem a regra de port forwarding, o roteador descartava a conexão. Dentro de casa funcionava porque eu entrava direto pelo IP privado, sem passar pelo roteador.

Do lado do firewall, a lógica de "fechar tudo e abrir o necessário" fica assim:

```bash
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -s 192.168.0.0/24 -j ACCEPT   # SSH só da rede de casa
iptables -A INPUT -p tcp --dport 25565 -j ACCEPT                  # Minecraft para o mundo
iptables -P INPUT DROP
```

E a JVM, com limites de memória explícitos em vez de deixar o padrão decidir:

```bash
java -Xms2G -Xmx2G -jar server.jar nogui
```

`-Xmx` é o teto da memória da JVM. Quando os objetos vivos chegam perto dele, o Garbage Collector trabalha cada vez mais, o servidor engasga, e se nem assim sobra espaço vem o `OutOfMemoryError`. Colocar `-Xms` igual ao `-Xmx` evita que a JVM fique crescendo e encolhendo a memória durante o jogo.

## Resultado

O servidor passou a ser alcançável por nome, protegido por um firewall que eu entendia e com memória configurada de propósito, não por sorte. Abrir o servidor para fora me ensinou NAT, portas e firewall. Dimensionar a JVM me ensinou memória e Garbage Collection.

A base que eu tenho hoje em redes e infraestrutura começou aqui, num PC doméstico, resolvendo restrições reais para que os jogadores conseguissem entrar.

## O que eu levo disso

Quando o sintoma é "não conecta", eu checo camada por camada, de fora para dentro: nome, rota, porta, firewall, processo. É o mesmo diagrama acima, só que hoje com balanceador, proxy e nuvem no lugar do roteador de casa.

E administrar a própria infraestrutura, pelo menos uma vez, muda a forma como se escreve software. Quem já viu um processo morrer por falta de memória pensa duas vezes antes de carregar tudo numa lista.
