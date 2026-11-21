---
title: "Entrar como o cliente: links de suporte com prazo, uso único e rastro"
summary: "O suporte precisava ver o painel exatamente como o cliente vê, sem pedir senha e sem criar uma chave mestra. Criei links de acesso que valem uma vez, expiram em minutos e registram quem entrou em qual conta."
project: great-softwares
order: 15
tags: [Autorização, Sessões, Impersonation, Rate Limit, Segurança]
---

Um cliente abre um chamado dizendo que um botão do painel não aparece para ele. O atendente olha a própria tela e o botão está lá. A diferença pode ser o plano, o perfil do usuário, uma configuração da marca, um dado específico da conta. Sem ver o que o cliente vê, o suporte fica pedindo print e adivinhando. Pedir a senha do cliente está fora de questão. O que o time precisava era um "entrar como" de verdade no Great Apps, e eu sabia que essa é uma das funcionalidades mais perigosas que se pode colocar num sistema.

## O problema

"Entrar como" (*impersonation*) é abrir uma sessão autenticada como outro usuário. Mal desenhado, vira uma chave mestra: um operador curioso entra em qualquer conta, um link vazado dá acesso permanente, ou um usuário comum descobre um jeito de se passar por alguém acima dele.

O sistema também tem dois painéis: o app, que o cliente usa, e o admin, onde donos de whitelabel (marcas que revendem a plataforma com a própria identidade) administram seus clientes. Um acesso emitido para um painel não pode abrir o outro.

## Por que não era trivial

Os requisitos puxam em direções opostas.

- **Rápido para o operador**, mas sem virar login eterno.
- **Funcionar nos dois painéis**, com regras diferentes para cada um.
- **Hierarquia respeitada no servidor.** Dentro de uma conta, um perfil menor não pode entrar como um perfil maior. Acesso ao admin só faz sentido para quem é dono de uma whitelabel ativa.
- **Rastro de auditoria.** Toda ação feita dentro da sessão precisa ser atribuível a quem realmente está do outro lado.
- **Sem renovação infinita.** Um operador dentro de uma sessão de suporte consegue, em tese, emitir outro link a partir dela. Se cada link novo zerasse o relógio, a sessão nunca terminaria.

## A solução

Separei o fluxo em duas chamadas: emitir e resgatar.

### Emitir

O operador, autenticado com uma sessão própria de operador, pede acesso para até 20 alvos de uma vez. Cada alvo é um par usuário e audiência (`app` ou `admin`). O servidor avalia cada alvo por regra, sem confiar em nada que o cliente diga sobre permissões:

- o perfil do operador precisa estar na lista de perfis que podem emitir;
- audiência `admin` só é emitida a partir da whitelabel principal e só para usuários de contas donas de outra whitelabel ativa;
- se o alvo é da mesma conta do operador, o perfil do operador precisa ser igual ou maior que o do alvo;
- alvo inexistente é recusado com um código próprio.

Para cada alvo aprovado, o servidor gera um token aleatório de 32 bytes e devolve uma única vez. No banco vai só um HMAC do token com um segredo do servidor (*pepper*). Quem tiver uma cópia do banco não tem nenhum link utilizável. O token vale 5 minutos.

### Resgatar

O resgate passa primeiro por um rate limit por IP e por uma validação de formato do token, para barrar tentativa de adivinhação antes de tocar o banco. Depois, o servidor encontra o registro pelo hash e consome o link com uma atualização condicional: só marca como usado se ainda não foi usado e se não expirou. Se duas abas tentam o mesmo link ao mesmo tempo, o banco decide, e uma delas recebe "link já utilizado".

A sessão aberta carrega duas marcas: o método de login é `impersonation` e o campo `impersonated_by` guarda o operador real. Isso vale mesmo quando o link foi emitido a partir de outra sessão de suporte: a identidade que viaja é sempre a do humano original.

Quando o link nasceu dentro de uma sessão de suporte, o resgate faz três checagens extras: o operador original ainda tem perfil válido, a sessão emissora ainda existe, e a nova sessão herda o teto de 12 horas contado a partir do início da sessão emissora.

Os erros saem com código estável e HTTP coerente: 400 para pedido inválido, 403 para proibido, 404 para alvo inexistente, 410 para link expirado ou já usado, 429 para excesso de tentativas.

## Um exemplo

Uma linha do tempo fictícia mostra o teto em ação. O operador O abre o admin de uma whitelabel e, de dentro dele, emite um link para entrar no app de um cliente dessa marca.

| Hora | Evento | Expira em |
| --- | --- | --- |
| 09:00 | O resgata um link e abre sessão de suporte no admin da marca | 21:00 |
| 09:02 | De dentro dessa sessão, O emite link para o cliente C (app) | link: 09:07 |
| 09:03 | O resgata o link de C | sessão de C: 21:00, não 21:03 |
| 09:03 | Outra aba tenta o mesmo link | 410, já utilizado |
| 20:50 | O emite outro link a partir da sessão de C | link: 20:55 |
| 20:51 | O resgata | sessão nova: 21:00 |
| 21:00 | Todas as sessões da cadeia vencem juntas | |

Encadear links não estica nada. O relógio é o da primeira sessão.

O coração do resgate é o consumo condicional, num único comando:

```ts
async function consumeSupportLink(tokenHash: string, now: Date) {
  // A condição no próprio UPDATE elimina a janela entre "ler" e "marcar":
  // de dois resgates simultâneos, só um recebe a linha de volta.
  const rows = await db.query(
    `UPDATE support_links
        SET used_at = $2
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > $2
      RETURNING target_user_id, operator_id, issuer_session_started_at`,
    [tokenHash, now],
  );
  if (rows.length === 0) return { error: "LINK_USED_OR_EXPIRED", status: 410 };
  return rows[0];
}

function sessionCeiling(issuerStartedAt: Date | null): Date | null {
  if (!issuerStartedAt) return null;
  return new Date(issuerStartedAt.getTime() + 12 * 60 * 60 * 1000);
}
```

## Resultado

O suporte entra na conta com um link que dura minutos, funciona uma vez e deixa registro de quem agiu. Um link interceptado depois de usado não serve. Uma cópia do banco não serve, porque só o hash está lá. E nenhuma sessão de suporte passa de 12 horas, por mais que o operador encadeie links.

No mesmo desenho, revisei duas amarras que atrapalhariam operadores legítimos sem acrescentar segurança real: a sessão de operador presa ao user-agent do navegador e a emissão de links dependente do IP do operador. Os dois mudam por motivos banais, como atualização do browser ou troca de rede, e derrubariam quem está no meio de um atendimento. Tirei as duas e mantive os controles que importam: prazo, uso único e hierarquia.

## O que eu levo disso

Todo "entrar como" precisa de cinco coisas: prazo curto, uso único, hash em repouso, regra de hierarquia aplicada no servidor e um teto absoluto para encadeamento. E a sessão precisa carregar a identidade do operador, não só a do alvo. Sem isso, o log de auditoria diz que o cliente fez algo que, na verdade, foi o suporte.
