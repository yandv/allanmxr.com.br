---
title: SchanNetwork
role: Fundador e desenvolvedor
period: 2014 a 2016
summary: "Meu primeiro servidor de Minecraft, rodando no PC de casa, sem curso e sem ninguém a quem perguntar. Cada problema virou aula: aprendi Java abrindo plugins dos outros, versionei com Git e entendi redes a cada queda."
order: 11
stack: [Java, Bukkit/Spigot, TerrainControl, Git, Allatori, API do Twitter, OAuth, Linux, DNS, iptables, NAT]
videos:
  - id: -o5d7bxu5ww
    title: Gameplay no SchanNetwork
  - id: ABNkgo_PLeI
    title: Gameplay no SchanNetwork, parte 2
  - id: Bckbfy9yHNo
    title: Gameplay no SchanNetwork, parte 3
---

## O contexto

O SchanNetwork foi o meu primeiro servidor de Minecraft, entre 2014 e 2016. Eu era moleque, apaixonado pelo jogo e decidido a ter um servidor com a minha cara. Não sabia programar e não tinha a quem perguntar. O servidor rodava no PC da minha casa, e cada problema que aparecia, de plugin quebrado a jogador que não conseguia entrar, virava uma aula que eu mesmo precisava dar.

Tenho muito orgulho desse projeto, não pelo tamanho, mas porque foi onde aprendi a aprender: ler o código dos outros, quebrar, consertar e entender o porquê.

## Meu papel

Fundador e único desenvolvedor. Escolhi os plugins, escrevi os meus, administrei a máquina, cuidei da rede e respondi quando algo caía, inclusive nos piores horários.

## Arquitetura em alto nível

- **Servidor Bukkit/Spigot** (a plataforma que permite estender o Minecraft com plugins em Java), com plugins de terceiros e plugins meus.
- **Plugins próprios em Java**, versionados com Git e protegidos com o ofuscador Allatori.
- **Integração com a API do Twitter**, autenticada com OAuth, para publicar cada banimento na conta @SchanBan.
- **Gerador de mapas TerrainControl** para criar o terreno das partidas de Hardcore Games.
- **Máquina Linux em casa**, com domínio próprio, DNS, port forwarding no roteador (por causa do NAT da internet residencial) e firewall com iptables.

## Decisões de arquitetura

- **Aprender lendo código de produção.** Sem curso, decompilei os plugins que já rodavam no servidor e segui a lógica deles linha a linha. Foi o jeito de aprender Java e a API do Bukkit ao mesmo tempo.
- **Proteger o que eu escrevia, sabendo o limite da proteção.** Depois de aprender a ler código ofuscado, passei a ofuscar os meus plugins com o Allatori, entendendo que ofuscação aumenta o esforço de quem copia, mas não guarda segredo.
- **Levar a moderação para fora do jogo.** Cada banimento virava um tweet, publicado fora da thread principal do servidor para que uma API externa lenta nunca travasse o jogo.
- **Versionar tudo com Git.** Para voltar uma versão em segundos quando uma mudança quebrava o servidor e parar de editar direto em produção.
- **Não gerar mapa na hora do jogo.** A geração de terreno disputava CPU com os jogadores e chegava a derrubar o servidor. Passei a gerar os mapas antes, fora do horário de jogo, ideia que mais tarde sistematizei no SaintMC.
- **Aprender infraestrutura pela falha.** Cada queda de conexão me ensinou DNS, NAT, portas e firewall, e cada crash da JVM me ensinou memória e Garbage Collection.
