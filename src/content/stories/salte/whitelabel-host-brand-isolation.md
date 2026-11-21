---
title: "Multi-tenant em dois níveis: a clínica na rota e a marca no Host"
summary: "Os mesmos Workers servem várias marcas de ERP, cada uma com domínio, contas e e-mails próprios, e dentro de cada marca várias clínicas isoladas. Desenhei a marca para ser resolvida uma vez, pelo Host, e carregada em tudo que depende dela: identidade, token, cookie, CORS, remetente e limites."
project: salte
order: 1
tags: [Multi-tenant, Whitelabel, Cloudflare Workers, CORS, Cookies, Hono]
---

Uma rede de clínicas quer oferecer o ERP da Salte com a própria marca: o próprio domínio, o próprio logo, e-mails saindo do próprio endereço. A mesma recepcionista pode trabalhar numa clínica dessa rede e, à noite, numa clínica que usa a Salte com a marca original, com o mesmo e-mail nas duas. Para ela, são dois produtos. Para a infraestrutura, é o mesmo código, nos mesmos Workers, no mesmo banco. O desenho precisava fazer essas duas verdades conviverem sem que uma marca enxergasse a outra.

## O problema

A Salte é multi-tenant em dois níveis. No nível de baixo, cada clínica é um tenant isolado: pacientes, agenda, financeiro e equipe de uma clínica nunca aparecem para outra. No nível de cima, cada marca whitelabel é um universo de contas: o mesmo e-mail pode ter uma conta em cada marca, com senha, login com Google e MFA próprios.

O nível da clínica é visível na URL: toda rota de negócio leva o id da clínica no caminho. O nível da marca não está em lugar nenhum da requisição, a não ser no Host. É dele que a API precisa tirar, a cada chamada, qual marca está falando, e daí decidir quem pode entrar, de onde o navegador pode chamar, em que domínio o cookie vale, de qual endereço o e-mail sai e em qual balde o limite de requisições conta.

## Por que não era trivial

Uma marca mal resolvida não falha de forma barulhenta. Ela grava a linha com a marca errada, aceita a sessão de outra marca ou manda o e-mail com o remetente errado, e tudo continua parecendo funcionar.

Cookies e CORS têm regras próprias do navegador. Um cookie com o domínio de uma marca não pode valer no domínio de outra, e a checagem de "este host pertence a este domínio" precisa olhar o sufixo com ponto, senão um domínio como `malsalte.app` passaria por `salte.app`. O mesmo vale para a lista de origens que podem fazer chamadas com credenciais.

E trabalho em segundo plano não tem Host. Um job noturno que manda lembrete de consulta precisa saber a marca da clínica sem nenhuma requisição para perguntar.

## A solução

### A marca é resolvida uma vez, na entrada

Um middleware logo no início da pilha normaliza o Host (minúsculas, sem porta, sem ponto final, com cuidado para IPv6) e procura a marca por igualdade numa coluna única de domínios. A mesma normalização vale para o Host da requisição, para a Origin e para o domínio que um operador digita no cadastro, então não há duas formas de escrever o mesmo endereço. O resultado fica no contexto da requisição, e todo o resto lê dali.

Os domínios próprios da Salte e os hosts locais caem na marca padrão por uma constante, sem consulta. Para as marcas clientes, a consulta passa por cache, renovado quando o cadastro muda.

Host desconhecido e marca suspensa recebem o mesmo 404 neutro, sem dizer o que foi procurado. Se a consulta falha num host de cliente, a resposta é 503, nunca um "na dúvida, é a Salte". Cair na marca padrão aceitaria a sessão errada ali e gravaria a marca errada em linhas novas.

### Identidade por marca, garantida pelo banco

O e-mail é único por marca, não globalmente: um índice único parcial em e-mail mais marca. A coluna de marca do usuário não tem valor padrão de propósito: um insert que esquece a marca falha, em vez de cair silenciosamente na marca original. Códigos de cadastro e de recuperação também são consumidos por e-mail e marca, então um código emitido numa marca não é aceito, nem queimado, na outra.

### O token carrega a marca

O token de acesso e o de renovação levam a marca como claim. A autenticação compara essa claim com a marca do Host e recusa a diferença com a mesma mensagem genérica de token vencido, para não ensinar nada a quem testa. Na renovação, a checagem da marca acontece antes de consumir o refresh, para que uma tentativa numa marca não gaste a sessão legítima na outra. O login com Google guarda o estado do fluxo com a marca na chave e usa a URL de retorno da API da marca que começou o fluxo.

### Cookie, CORS, remetente e limites

Os cookies de sessão são host-only, com o prefixo `__Host-`, `Secure` e `SameSite=Strict`: o navegador só os envia ao host exato que os criou. O CORS de uma marca cliente aceita só as origens dessa marca. O remetente próprio só é usado quando o endereço está configurado, verificado no provedor de e-mail ativo e pertence ao domínio cadastrado; senão, o e-mail sai pela Salte. E as chaves do limitador de requisições levam o prefixo da marca, para que as tentativas de login de uma marca nunca contem na outra.

### A clínica, dentro da marca

Dentro de cada marca, a rota da clínica passa por uma checagem de vínculo que responde 404 tanto para clínica inexistente quanto para clínica alheia, então ninguém descobre ids de clínicas testando. As permissões são calculadas em camadas: o dono tem tudo; os outros partem do padrão do perfil (gestor, profissional de saúde, recepção, comercial), recebem as regras da clínica e por fim as exceções por pessoa, ligadas ou desligadas uma a uma. Uma ação só vale se o módulo dela também estiver liberado. O resultado fica em cache curto e é derrubado na hora quando o perfil, o vínculo ou uma permissão mudam.

Jobs, crons e webhooks resolvem a marca pela clínica, nunca por requisição.

## Um exemplo

Duas marcas fictícias: "Vitalis", com app e API em `vitalis.com.br`, e "Odonto+", em `odontomais.com.br`. A Ana usa as duas com o mesmo e-mail.

| Passo | Requisição | O que a API decide |
| --- | --- | --- |
| 1 | Ana se cadastra nas duas marcas | Duas contas, permitidas pelo índice e-mail mais marca |
| 2 | Login em `api.vitalis.com.br` | Token com a marca Vitalis, cookie `__Host-` só nesse host |
| 3 | Um script reenvia esse token para `api.odontomais.com.br` | 401 com a mensagem de token vencido |
| 4 | O mesmo script tenta renovar com o refresh da Vitalis na Odonto+ | Recusado antes de consumir o refresh: a sessão na Vitalis segue viva |
| 5 | Ana, recepcionista na Vitalis, recebe uma exceção que libera o financeiro | Só vale se o módulo financeiro também estiver liberado para ela |
| 6 | A clínica dela manda um convite | Sai pelo remetente da Vitalis se o domínio estiver verificado; senão, pela Salte |

A checagem do token, em forma resumida:

```ts
type Claims = { sub: string; wl?: string };

function brandMatches(claims: Claims, requestBrandId: string, defaultBrandId: string): boolean {
  // tokens antigos, sem a claim, valem como da marca padrão durante a migração
  return (claims.wl ?? defaultBrandId) === requestBrandId;
}

// em caso de diferença, a resposta é a mesma de um token vencido
```

## Resultado

Uma marca nova é um cadastro, não um deploy: domínios, identidade visual, domínio de cookie e remetente. Cada marca enxerga só as próprias contas e sessões, e cada clínica enxerga só os próprios dados, com o banco recusando as combinações que o código poderia esquecer. Os casos de fronteira, como token de uma marca em outra, código de recuperação cruzado e falha na consulta da marca, viraram testes.

## O que eu levo disso

Quando o tenant não está na URL, ele precisa ser resolvido num ponto só e carregado explicitamente para tudo que depende dele, inclusive o banco e o token. E na dúvida sobre de quem é a requisição, a resposta certa é recusar, nunca escolher um dono padrão.
