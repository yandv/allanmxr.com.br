---
title: Araute
role: Tech Lead e Engenheiro de Software
period: Jul 2026 até hoje
summary: "Uma plataforma de pagamentos não pode cobrar, creditar nem emitir nota duas vezes. Construo a Araute de ponta a ponta, da API ao painel e ao SDK, para que todo saldo do lojista possa ser explicado lançamento por lançamento."
order: 2
links:
  - href: https://www.araute.com
    label: Site da Araute
  - href: https://docs.araute.com
    label: Documentação pública
  - href: https://app.araute.com
    label: Painel do lojista
stack: [TypeScript, Hono, Kysely, Zod, PostgreSQL, Hyperdrive, Cloudflare Workers, Queues, Cron, Durable Objects, Containers, OpenAPI, TanStack Start, React, Tailwind CSS, Vitest, Playwright]
resume:
  company: Araute
  title: Tech Lead e Engenheiro de Software
  location: Remoto
  start: 2026-07
  sideProject: true
  order: 2
  bullets:
    - Construí a API pública de pagamentos (Pix, Pix Automático, boleto, cartão, assinaturas e links) em Hono, Kysely e PostgreSQL sobre Cloudflare Workers, integrada à Woovi, com contrato OpenAPI e erros em Problem Details.
    - Modelei o dinheiro em livro-razão de partidas dobradas, com webhooks por outbox e conciliação periódica contra os provedores.
    - Implementei a emissão de NFS-e com custódia isolada do certificado A1 e mTLS por container dedicado, além do painel do lojista e do SDK @araute/js.
---

## O contexto

A Araute é uma plataforma de pagamentos para lojistas. O lojista integra uma API e recebe por Pix, Pix Automático, boleto e cartão, cria links de pagamento e assinaturas e emite nota fiscal de serviço. Como o produto movimenta dinheiro, a maior parte do trabalho é garantir que nada seja cobrado, creditado ou emitido duas vezes e que qualquer saldo possa ser reconstituído depois, lançamento por lançamento.

## Meu papel

Sou tech lead e engenheiro de software da Araute. Defino a arquitetura e as fronteiras entre os serviços, tomo as decisões técnicas e deixo os trade-offs escritos, reviso o que entra e escrevo código de ponta a ponta: a API (Hono sobre Cloudflare Workers, com PostgreSQL acessado via Hyperdrive), o painel do lojista, o painel de operação, a documentação pública e o SDK de navegador.

## Arquitetura em alto nível

- **API pública:** Hono e Kysely sobre Workers, organizada em um módulo por recurso, com Queues e Cron para o trabalho assíncrono. Valida a entrada com Zod e gera o contrato OpenAPI a partir dos mesmos schemas.
- **Custódia fiscal:** um serviço sem rota pública, alcançável só pela API, que guarda os certificados digitais dos lojistas e assina as notas. A conexão com certificado de cliente (mTLS) com o órgão emissor sai por um container dedicado.
- **Painel do lojista:** TanStack Start em React, com tipos gerados a partir do OpenAPI.
- **Painel de operação:** a interface interna do time, protegida na borda e autorizada de novo na API.
- **SDK (`@araute/js`):** pacote aberto que monta o campo de cartão do checkout transparente no navegador do comprador, sem o número do cartão passar pelos servidores do lojista.
- **Documentação e site:** o site público e a documentação para quem integra.
- **Design system:** um pacote de componentes compartilhado pelos dois painéis.

A API conversa com os provedores de pagamento por adaptadores que traduzem tudo para eventos internos. O dinheiro é registrado num livro-razão de partidas dobradas, e uma conciliação periódica confere o que o provedor diz contra o que o livro-razão registra.

## Decisões de arquitetura

- **Módulo por recurso, com fronteiras checadas no build.** Cada recurso tem seu módulo, e uma regra de grafo de imports quebra o build quando uma zona importa o que não devia. A mesma ferramenta me deixou juntar serviços fiscais que antes eram separados por deploy sem perder o isolamento entre eles.
- **Efeito só depois do commit.** Trabalho em segundo plano disparado dentro de uma transação é descartado se ela der rollback, e os webhooks enviados ao lojista nascem de um outbox gravado na mesma transação que muda o estado.
- **Erros no formato Problem Details (RFC 7807) com `code` estável.** O `code` é o contrato com quem integra, cada erro carrega um identificador de rastreio da requisição, e o nome do provedor nunca aparece no título nem no detalhe.
- **OpenAPI como contrato.** Documentação, tipos dos painéis e dados de teste derivam da especificação, e a CI barra divergência entre os schemas do código e o arquivo publicado.
- **Testes em fuso real.** A suíte roda em `America/Sao_Paulo` de propósito, porque em UTC os bugs de data ficam invisíveis.
- **Trade-off de segurança escrito.** Quando troquei uma separação por deploy por uma regra de imports na custódia fiscal, registrei o que a nova forma deixou de cobrir e qual controle compensa, para a decisão poder ser revista.
