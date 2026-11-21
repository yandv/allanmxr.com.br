---
title: Yield
role: Criador, projeto pessoal pausado
period: Mai 2026, pausado
summary: "Quem tem conta em vários bancos não enxerga para onde vai o dinheiro. Construí sozinho a primeira versão de um app que junta as contas por Open Finance, classifica os gastos e detecta assinaturas."
order: 4
stack: [TypeScript, Hono, Kysely, Zod, PostgreSQL, Cloudflare Workers, TanStack Start, React, Tailwind CSS, Pluggy]
---

## O contexto

O Yield junta todas as contas da pessoa num lugar só, puxando os dados direto dos bancos pelo Open Finance (o padrão regulado do Banco Central para compartilhar dados bancários com autorização do cliente), via Pluggy. Em cima disso, classifica os gastos, detecta cobranças recorrentes e mostra o patrimônio. Construí a primeira versão do app e da API. Os problemas mais interessantes que resolvi estão nos posts abaixo.

## Meu papel

Desenvolvedor fullstack, sozinho nas duas pontas. Desenhei o modelo de dados, a API, o pipeline de sincronização e classificação, a detecção de recorrências, a autenticação com 2FA e o front.

## Arquitetura em alto nível

- **API (Hono, Kysely, PostgreSQL via Hyperdrive, Cloudflare Workers):** um módulo por entidade de negócio, cada um com controller, serviço, repositório e schema Zod, montados a cada requisição sem framework de injeção.
- **Webhook da Pluggy:** endpoint público autenticado por um cabeçalho secreto, que registra o evento, responde 2XX na hora e dispara a sincronização em segundo plano.
- **Fila de classificação (Cloudflare Queues):** processa os pedidos de classificação, categoriza as transações por apelidos de estabelecimento e regras, grava o resultado numa camada separada e, no fim, reconcilia as recorrências.
- **Recorrências:** um detector puro, sem efeitos colaterais, e uma tabela de séries materializada, atualizada a cada classificação.
- **Autenticação:** sessões com refresh token rotativo agrupado por família, 2FA por TOTP (o código de seis dígitos do app autenticador) e códigos de recuperação.
- **App (TanStack Start, React, Tailwind):** consome a API e traduz para português os códigos de erro, que vêm prefixados pelo módulo de origem.

## Decisões de arquitetura

- **Kysely sem ORM**, com repositórios por módulo e filtros resolvidos no SQL, incluindo uma coluna de busca desnormalizada na transação para não depender de joins na listagem.
- **Idempotência no banco.** Um índice único parcial no id externo da Pluggy em cada tabela espelhada garante que o mesmo dado nunca entra duas vezes, sem precisar de uma transação gigante de ponta a ponta.
- **Classificação separada do dado bancário.** Categoria e edições do usuário vivem numa camada própria, então ressincronizar com o banco nunca apaga o que a pessoa ajustou.
- **Recorrências materializadas**, e não só calculadas na leitura, para lembrar séries canceladas e decisões do usuário.
- **Cache que respeita a transação:** escritas no cache só valem depois do commit, para nunca expor um estado que foi revertido.
- **Reconciliação pela fila**, para que abrir o dashboard nunca dispare escrita.
