---
title: Great Softwares
role: Engenheiro de Software Sênior
period: Fev 2026 até hoje
summary: "Os três produtos da Great dividem login, cobrança e domínios, então um erro num deles chega aos outros. Construo os três de ponta a ponta: o construtor Great Pages, a conta e cobrança Great Apps e o registrador Great Domains."
order: 1
links:
  - href: https://greatsoftwares.com.br
    label: Site da Great Softwares
  - href: https://greatpages.com.br
    label: Great Pages
  - href: https://greatdomain.com.br
    label: Great Domains
stack: [TypeScript, Hono, Cloudflare Workers, Durable Objects, WebSocket, Queues, Workflows, R2, PostgreSQL, Kysely, Zod, EPP, MCP, Next.js, React, Tailwind CSS, OpenNext, Vitest]
resume:
  company: Great Softwares
  title: Engenheiro de Software Sênior
  location: Barueri, SP
  start: 2026-02
  order: 1
  bullets:
    - Construí de ponta a ponta os três produtos da empresa (Great Pages, Great Apps e Great Domains), da API em Hono sobre Cloudflare Workers e PostgreSQL ao editor visual em Next.js.
    - Desenvolvi a edição colaborativa em tempo real do editor de páginas com Durable Objects e WebSocket, com estado em SQLite na borda e custo de escrita medido por teste.
    - Criei um servidor MCP para agentes de IA controlarem páginas, blogs, quizzes e apresentações, com OAuth, escopos e confirmação das escritas verificada pelo servidor.
    - Implementei o registrador Great Domains do zero, com OpenSRS e domínios .br via EPP no Registro.br, e pedidos protegidos por idempotência e transições condicionais.
    - Integrei a cobrança com Pix Automático, boleto, cartão e afiliados usando Stripe, Woovi e Vindi, com conciliação dos mandatos e faturas.
---

## O contexto

A Great tem três produtos que conversam entre si. O **Great Pages** é um construtor de páginas, blogs, quizzes, apresentações e sites importados, com um editor visual, edição com IA e publicação em domínio próprio. O **Great Apps** é a plataforma de conta e cobrança que os produtos compartilham: login, planos, assinatura e créditos. O **Great Domains** é o registrador de domínios. Tudo roda na borda da Cloudflare, com APIs em Hono, PostgreSQL e front em Next.js.

## Meu papel

Entrei em fevereiro de 2026 como engenheiro de software sênior, com atuação fullstack, e trabalho nos três produtos, da API ao editor visual. No Great Pages, minhas frentes mais marcantes foram a edição colaborativa em tempo real, o servidor MCP, a edição e o chat de IA do editor, a importação e a clonagem de sites, a publicação com domínio próprio e SSL e o front em Next.js na Cloudflare. No Great Domains e no Great Apps, o registro de domínios, os pedidos e a cobrança. Os problemas mais interessantes que resolvi viraram os posts abaixo.

## Arquitetura em alto nível

- **Editor** em Next.js 16 com OpenNext em Workers. Fala com a API por Route Handlers (leituras) e Server Actions (mutations), e com a sala colaborativa por WebSocket.
- **API do Great Pages** em Workers: páginas, projetos, domínios, publicação, design systems, experimentos A/B e importação de sites. Persiste em PostgreSQL e publica artefatos no R2.
- **Serviço de colaboração**: um Durable Object por sala (página mais variação de teste A/B) e um por tema, com estado no SQLite do próprio objeto e gravação de volta na API em segundo plano.
- **Serviço de IA** do editor: chat com agentes e edição de elementos por operações semânticas, com cobrança em créditos.
- **Servidor MCP**: fachada fina que expõe a plataforma a agentes de IA, com OAuth, escopos e confirmação nas escritas.
- **Serviços de apoio**: clonador de sites com navegador remoto, miniaturas de página por fila, armazenamento em R2, SSL de domínios próprios e prévias servidas num domínio isolado.
- **Great Apps e Great Domains**: APIs próprias em Hono, com PostgreSQL, filas e integrações de pagamento e de registro de domínios.
- **Bibliotecas compartilhadas** entre os fronts para autenticação, componentes de conta e cobrança, e acesso tipado às APIs.

## Decisões de arquitetura

- **Estado no lugar certo.** A sala colaborativa vive no SQLite do Durable Object, sem banco externo no caminho quente. Como a plataforma cobra por linha gravada, o custo de escrita é medido por teste, com teto por operação.
- **Servidor autoritativo e operações pequenas.** Colaboração, edição de tema e edição com IA mandam operações idempotentes em vez de documentos inteiros. Uma lista de mudanças se mescla, e dois editores deixam de se sobrescrever.
- **Fronteira fechada onde o chamador não é confiável.** O MCP e a edição com IA usam listas fechadas, hash de contrato e confirmação verificada pelo servidor, porque argumento de ferramenta é texto que passou por um modelo.
- **Idempotência por chave e por transição condicional**, em vez de locks, nos fluxos de cobrança e de registro. Um lock em cache na borda vale só para o data center onde foi gravado.
- **Arquitetura hexagonal** (portas e adaptadores) nas APIs novas, com testes que garantem as fronteiras. O domínio roda no Node sem I/O, e o comportamento de Durable Object é validado no workerd, o runtime real dos Workers.
- **Contrato de erro estável** e documentado, conferido por teste dos dois lados, e exposição mínima: segredos fora do repositório e respostas que devolvem só os campos necessários.
