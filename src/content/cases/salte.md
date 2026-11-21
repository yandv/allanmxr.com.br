---
title: Salte
role: Tech Lead e Engenheiro de Software
period: Fev 2026 até hoje
summary: "A Salte é um ERP para clínicas: agenda e recepção, prontuário e documentos assinados, financeiro, repasse a profissionais, conta bancária, convênios, estoque, cobrança da assinatura e app mobile, com a IA clínica como uma camada a mais. Como tech lead, cuido da arquitetura e escrevo código em todas essas frentes."
order: 3
links:
  - href: https://salte.app
    label: Site da Salte
stack: [TypeScript, Hono, Cloudflare Workers, Durable Objects, PostgreSQL, Hyperdrive, D1, R2, Zod, TanStack Start, React, Expo, LLMs, RAG, Evals]
resume:
  company: Salte
  title: Tech Lead e Engenheiro de Software
  location: Remoto
  start: 2026-02
  sideProject: true
  order: 3
  bullets:
    - Lidero a arquitetura de uma plataforma de gestão para clínicas multi-tenant por clínica e whitelabel por marca, em Hono sobre Cloudflare Workers e PostgreSQL via Hyperdrive, com os mesmos Workers servindo várias marcas pelo domínio.
    - Estruturei o financeiro da clínica sobre um livro-razão append-only, com contas a pagar e receber, caixa, repasse a profissionais e conta bancária via Woovi com Pix e boleto.
    - Organizei o faturamento de convênios em guias e lotes mensais conciliados em contas a receber, além do billing da plataforma com planos, assinaturas, checkout e cupons.
    - Conduzi o app mobile em Expo para iOS e Android sobre a mesma API, com login com MFA, chat com os agentes e transcrição de consulta.
    - Desenvolvi a IA clínica, um motor de evidência com LLMs e busca híbrida que cita a fonte ou se abstém, medido por evals, e um agente que opera os sistemas web da clínica por chat.
---

## O contexto

A Salte é um ERP para clínicas. Uma clínica agenda, recebe o paciente na recepção, organiza a fila de atendimento, atende, registra o prontuário, emite e assina receitas e atestados, controla o estoque, cobra o paciente, fatura o convênio, paga os profissionais e movimenta a própria conta bancária sem sair do sistema. A equipe conversa por um chat interno, e o app mobile, em iOS e Android, leva para o celular o login com MFA, a conversa com os agentes, a transcrição de consulta e a assinatura de receitas e atestados.

O produto é multi-tenant em dois níveis. Cada clínica é um tenant isolado, com permissões por perfil e por pessoa. Acima disso, ele é whitelabel por marca: os mesmos Workers atendem várias marcas, cada uma com domínio, identidade visual e contas de usuário próprias.

A IA clínica é uma camada sobre esse ERP: um motor de evidência que responde com a fonte citada e um agente que opera o sistema por conversa. Ela tem os próprios posts, mais abaixo. Como a Salte lida com dado de saúde e com dinheiro, cada decisão parte da pergunta "o que acontece quando isso falha?".

## Meu papel

Sou tech lead e engenheiro de software da Salte desde fevereiro de 2026. Liderei, desenhei e codei o ERP inteiro: agenda e recepção, fila de atendimento e painel de chamada, prontuário e documentos assinados, financeiro e repasse a profissionais, conta bancária, convênios, estoque, billing da plataforma e o app mobile, além da camada de IA clínica.

Montei a base da API: a troca de Prisma por Knex, os esquemas Zod no lugar de entidades, ids públicos em UUIDv7, autenticação por cookie com MFA e login com Google, o multi-tenant por clínica e por marca, o middleware de transação, a camada de cache e o container de serviços por requisição. Defino a arquitetura e os padrões da API, do front web e do app, tomo as decisões técnicas e deixo os trade-offs escritos na documentação de cada módulo, reviso o que entra, trabalho em par com o time nas frentes mais sensíveis e escrevo as regras que o time e os agentes de código seguem.

Os posts abaixo contam os desafios de cada frente, do whitelabel por domínio ao repasse em lotes, da conta bancária com PIN transacional ao faturamento de convênios, e, mais adiante, os da IA clínica: o contrato de resposta com citações, a medição por evals e o cofre de senhas do agente.

## Arquitetura em alto nível

- **API do ERP (Hono em Cloudflare Workers, PostgreSQL via Hyperdrive):** um módulo por domínio, com rotas escopadas pela clínica e checagem de vínculo e de permissão em cada uma, validação com Zod nas bordas e um container de serviços por requisição.
- **Whitelabel pelo domínio:** o Host da requisição define a marca, e dela saem a identidade (o mesmo e-mail pode ter uma conta por marca), o CORS, o cookie de sessão, o remetente dos e-mails e os limites de requisição.
- **Identidade e acesso:** login com e-mail e senha ou Google, MFA com TOTP e códigos de recuperação, sessões por dispositivo, permissões por perfil e por pessoa e assentos do plano por tipo de profissional.
- **Agenda e recepção:** agendamentos, lista de espera, fila de atendimento por senha e prioridade e painel de chamada na TV da sala de espera, acessado por link secreto.
- **Clínico:** pacientes, triagem, prontuário, pedidos de exame e documentos clínicos com assinatura eletrônica avançada ou qualificada ICP-Brasil, receitas e modelos.
- **Financeiro da clínica:** contas a pagar e receber, caixa, centros de custo, notas fiscais e repasse aos profissionais em lotes.
- **Conta bancária da clínica:** Pix de entrada e saída, Pix agendado e boleto por meio da Woovi, atrás de um adaptador e protegidos por PIN de transação.
- **Convênios e estoque:** a consulta vira guia do convênio, as guias viram lotes conciliados em contas a receber, e o estoque controla itens, lotes e movimentações.
- **Billing da plataforma:** planos, módulos extras, compras avulsas, cupons e régua de cobrança para as clínicas assinarem a Salte, com Stripe, Woovi e Araute escolhidos por uma matriz de capacidades.
- **Tempo real:** Durable Objects distribuem os eventos do chat interno e do chat com o agente; a escrita sempre passa pela API REST e o Postgres é a fonte da verdade.
- **Front web e app mobile:** TanStack Start com React no navegador e Expo para iOS e Android, sobre a mesma API e contratos compartilhados num pacote comum.
- **IA clínica:** um motor de evidência em Worker próprio, com busca textual e vetorial, números resolvidos por código e abstenção quando não há base, e um agente que opera o ERP por conversa.

## Decisões de arquitetura

- **Clínica na rota, permissão em cada rota.** Toda rota de negócio carrega a clínica no caminho e passa por checagem de vínculo e de permissão, então o isolamento entre clínicas não depende de alguém lembrar de um filtro na consulta.
- **Marca resolvida uma vez, na entrada.** O Host vira o identificador da marca no início da requisição, e tudo que depende dela lê dali, em vez de cada módulo descobrir sozinho.
- **Uma única porta de escrita.** Toda mudança persistente passa pela API REST, com autenticação, permissão, limite e transação. WebSocket e Durable Objects só distribuem avisos; se a distribuição falha, o cliente se acerta pela API.
- **Fornecedor atrás de adaptador, escolhido por dados.** Conta bancária, cobrança, notas e assinatura qualificada falam com os provedores por adaptadores. No billing, uma matriz de capacidades e uma função pura escolhem o gateway, e trocar ou somar um fornecedor não mexe na regra de negócio.
- **Concorrência decidida no banco.** Valores que se acumulam são incrementados no próprio SQL, unicidade é garantida por índice e transições de estado usam update condicional ao estado lido, sem lock em memória.
- **Sem framework onde o cold start conta.** Serviços são resolvidos preguiçosamente por requisição, sem reflexão nem container no boot, e esquemas Zod só são montados na primeira requisição que os usa.
- **O modelo escreve, o código calcula.** Na IA clínica, o rascunho traz marcações que funções puras resolvem, então a exatidão de uma dose não depende do modelo. E abster é uma resposta válida.
