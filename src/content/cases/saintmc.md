---
title: SaintMC
role: Desenvolvedor líder e arquiteto
period: 2019 a 2021
summary: "Numa rede de Minecraft com mais de 320 jogadores simultâneos, qualquer espera de banco virava lag e toda mudança precisava chegar a todos os servidores. Fui o desenvolvedor líder do núcleo, dos dados e da proteção da rede."
order: 10
stack: [Java, Bukkit/Spigot, BungeeCord, ProtocolLib, TerrainControl, Redis, MongoDB, Linux, Servidor dedicado]
cover: ../../assets/projects/saintmc/logo.png
gallery:
  - src: ../../assets/projects/saintmc/270-players.png
    alt: Lista do servidor mostrando 270 jogadores conectados ao SaintMC
  - src: ../../assets/projects/saintmc/jackster-pvp.png
    alt: Partida de KitPvP no SaintMC
videos:
  - id: B-hNJ2i42rw
    title: Vídeo promocional do SaintMC
  - id: JHokO9vaUb4
    title: Gameplay no modo KitPvP
  - id: u0VW_UXNA74
    title: CopaHG do SaintMC
  - id: yK0xWOpb2No
    title: Gameplay no modo HungerGames
resume:
  summary: Desenvolvedor líder de uma rede de Minecraft com mais de 320 jogadores simultâneos, com cache em camadas no Redis, MongoDB e anticheat próprio em Java.
  order: 3
---

## O contexto

O SaintMC foi uma rede competitiva de Minecraft que operei entre 2019 e 2021, com foco em Hardcore Games (partidas de sobrevivência em mapa novo a cada rodada) e KitPvP (combate com kits prontos). Chegou a passar de 320 jogadores simultâneos. Eram vários servidores de jogo atrás de um proxy, e tudo rodava em uma máquina dedicada que eu mesmo administrava, sem nuvem gerenciada, sem contêiner e sem pipeline de deploy automatizado.

O servidor de jogo trabalha em ciclos de 50 ms, os ticks. Qualquer coisa que bloqueasse a thread principal virava lag na cara do jogador, e qualquer mudança feita em um servidor precisava aparecer nos outros na hora. Boa parte do que construí ali eu uso até hoje: tirar I/O do caminho quente, invalidar cache por evento, filtrar pelo mais barato primeiro.

## Meu papel

Fui o desenvolvedor líder. Desenhei o núcleo compartilhado, a camada de dados, a comunicação entre servidores, a proteção do proxy, o anticheat e a rotina de operação da máquina.

## Arquitetura em alto nível

- **Proxy (BungeeCord):** recebe a conexão, valida o jogador, carrega a conta e escolhe o servidor de destino.
- **Servidores de jogo (Bukkit/Spigot):** lobbies e modos Hardcore Games, KitPvP e outros, cada um um plugin sobre o mesmo núcleo.
- **Núcleo comum:** módulo de regras de negócio e acesso a dados usado pelo proxy e pelos servidores de jogo.
- **MongoDB:** fonte da verdade das contas, clãs, reports e servidores.
- **Redis:** cache das contas, registro de servidores e barramento Pub/Sub entre todos os processos.
- **ProtocolLib:** acesso aos pacotes na camada de rede, usado pelo filtro de pacotes maliciosos e pelos checks do anticheat.

Cada servidor se registra no Redis ao subir e anuncia mudanças em canais Pub/Sub. O proxy escuta esses canais, mantém a lista de servidores ativos e escolhe o destino do jogador. Alterações de conta, clã e report também viajam por Pub/Sub, e cada processo atualiza a própria cópia em memória.

## Decisões de arquitetura

- **Nenhum I/O de banco no tick do jogo.** Mongo e Redis são acessados em threads assíncronas e a conta é carregada no pré-login assíncrono. O custo de esperar o banco é pago antes de o jogador entrar, nunca durante a partida.
- **Cache em camadas com invalidação por evento.** Memória, depois Redis, depois Mongo. Quando um campo muda, o servidor que alterou publica o evento e os outros atualizam a própria cópia, em vez de consultar o banco de novo.
- **Um núcleo, duas plataformas.** Regra de negócio e acesso a dados são escritos uma vez e rodam no proxy e nos servidores de jogo por trás de uma interface de plataforma pequena.
- **Estratégia de balanceamento por tipo de servidor.** Lobbies usam menor ocupação, partidas usam maior ocupação para encher uma sala antes de abrir outra.
- **Defesa em camadas na entrada.** O proxy filtra bot e país antes de qualquer lógica de jogo, do filtro mais barato ao mais caro, e o servidor de jogo descarta pacotes que servem só para derrubar.
- **Trabalho pesado fora do horário de pico.** A geração de mapas, que consumia a CPU da máquina inteira, passou a rodar de madrugada, e as partidas só escolhiam entre mapas prontos.
