---
title: Limite de tentativas no login em dois eixos, por e-mail e por IP
summary: "Como barrar quem testa senhas em massa sem bloquear quem só errou a senha nem o escritório que divide o mesmo IP. Desenhei limites por e-mail e por IP, avaliados juntos, e liguei atrás de uma flag depois de observar em homologação."
project: great-softwares
order: 14
tags: [Rate Limit, Cloudflare Workers, Segurança, Multi-tenant]
---

Mexendo no fluxo de login do Great Apps por outro motivo, uma pergunta de modelo de ameaça voltava sempre: o que impede um script de chamar a rota de login mil vezes por minuto testando senhas? A proteção era simples de descrever e fácil de adiar, e resolvi desenhá-la direito.

## O problema

As rotas que aceitam senha ou código (login, troca de senha e confirmação do segundo fator) não tinham teto de tentativas. Sem ele, fica espaço para força bruta contra uma conta e para *credential stuffing*, que é testar listas de e-mail e senha vazadas de outros sites.

O limite precisava parar esses dois ataques sem atrapalhar a pessoa que errou a senha três vezes seguidas, nem o escritório inteiro que sai para a internet pelo mesmo IP.

## Por que não era trivial

**Um eixo de limite não basta.** Limitar só por IP deixa passar um ataque distribuído em muitos IPs contra a mesma conta. Limitar só por e-mail deixa passar um único IP testando uma senha comum contra milhares de contas. Precisava dos dois, avaliados juntos.

**O IP não vem do socket.** A API fica atrás do app, então o IP da conexão é o do app. O IP real do usuário chega no corpo da requisição, junto com os dados de sessão que o app já enviava.

**A plataforma é multi-tenant.** O mesmo e-mail pode existir em whitelabels diferentes, que são marcas independentes rodando sobre o mesmo backend. A chave do limite precisa incluir o tenant, senão uma marca consome a cota da outra.

**Errar o teto derruba gente legítima.** Um limite apertado demais vira indisponibilidade no login, e esse é o pior lugar para causar uma.

## A solução

### Rate limit com o binding nativo do Workers

O Cloudflare Workers tem um binding de rate limit: você declara um limitador com teto e janela no arquivo de configuração e chama `limit({ key })` no código. Criei dois, um por e-mail normalizado (minúsculo, sem espaços) e outro por IP, ambos prefixados pelo tenant. Os dois rodam em paralelo e a requisição só passa se os dois deixarem.

### Resposta neutra e log útil

A resposta de bloqueio é `429` com um código estável e uma mensagem neutra, "muitas tentativas, aguarde um minuto". Ela não diz qual eixo estourou nem se o e-mail existe. O log, sim: registra qual eixo estourou e mascara o e-mail, para eu calibrar o teto olhando dados em vez de chutar.

### Atrás de uma flag

O middleware entra antes da autenticação e liga por uma flag de configuração. Isso me deixou publicar o código desligado, ligar em homologação, observar e só então ligar em produção.

## Um exemplo

Os limites ficaram em 10 tentativas por minuto por e-mail e 30 por minuto por IP. O valor do IP é maior de propósito: um escritório inteiro pode sair pelo mesmo IP.

Veja como os dois eixos se complementam em três cenários fictícios:

| Cenário | Eixo e-mail | Eixo IP | Resultado |
| --- | --- | --- | --- |
| Uma pessoa erra a senha 4 vezes | 4/10 | 4/30 | Passa |
| Um IP testa 1 senha em 200 contas | 1/10 em cada | estoura na 31ª | Bloqueado pelo IP |
| 50 IPs testam 3 senhas na mesma conta | estoura na 11ª | 3/30 em cada | Bloqueado pelo e-mail |

O núcleo do middleware é pequeno:

```ts
async function loginRateLimit(req: LoginRequest, env: Env) {
  const email = req.body.email?.trim().toLowerCase();
  const ip = req.body.ip;
  const tenant = req.params.tenantId;

  // Os dois eixos em paralelo: um sozinho deixa passar ataque distribuído
  // (só IP) ou um IP varrendo muitas contas (só e-mail).
  const [byEmail, byIp] = await Promise.all([
    email ? env.EMAIL_LIMITER.limit({ key: `${tenant}:${email}` }) : { success: true },
    ip ? env.IP_LIMITER.limit({ key: `${tenant}:${ip}` }) : { success: true },
  ]);

  if (byEmail.success && byIp.success) return null;

  logger.warn({ limitedByEmail: !byEmail.success, limitedByIp: !byIp.success, email: mask(email) });
  return json({ code: "LOGIN_RATE_LIMITED", message: "Muitas tentativas. Aguarde um minuto." }, 429);
}
```

## Resultado

Tentativa em massa de senha agora bate num `429` pelo eixo certo, e o log diz qual foi. Ninguém legítimo foi bloqueado na ativação, porque os tetos foram escolhidos com margem e observados em homologação antes de ligar em produção.

## O que eu levo disso

Rate limit de login precisa de mais de um eixo, porque cada ataque escapa de um eixo diferente. E todo controle que pode bloquear gente legítima nasce atrás de uma flag. A flag transforma um risco de indisponibilidade num ajuste que dá para observar e reverter em segundos.
