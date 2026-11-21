---
title: Domínio próprio em um clique e um SSL que avisa quando fica pronto
summary: "Conectar um domínio próprio exigia copiar registros DNS em outro painel e esperar o HTTPS sem nenhum retorno, o ponto clássico de desistência. Fiz a conexão em um clique e um aviso automático quando o certificado fica pronto."
project: great-softwares
order: 7
tags: [Domain Connect, DNS, SSL, Cloudflare for SaaS, Webhooks, RSA]
---

Imagine uma pessoa que termina a página de vendas no Great Pages e quer que ela abra em `www.minhaloja.com.br`. A tela mostra dois registros DNS para copiar. Ela abre o painel do provedor de DNS em outra aba, encontra três menus parecidos, cola o CNAME no lugar errado e volta ao editor sem saber se deu certo. Mesmo quando acerta, ainda espera o certificado HTTPS sem nenhum retorno. É exatamente o ponto em que alguém desiste.

## O problema

Havia duas metades. A primeira era configurar o DNS sem pedir que a pessoa entendesse DNS. Os registros certos mudam se o endereço é `www`, o domínio raiz ou um subdomínio, e cada provedor tem um painel diferente. A segunda era saber quando o certificado SSL ficava ativo. Acompanhar por fila, com uma mensagem por domínio consultando o status repetidas vezes, tem um limite de desenho: quando as tentativas da fila acabam, o acompanhamento para, e o domínio pode ficar pendente para sempre sem ninguém olhar.

## Por que não era trivial

Para o DNS escolhi o **Domain Connect**, um padrão aberto em que o provedor de DNS aplica um template de registros depois que a pessoa confirma no painel dele. O Great Pages entra como *Service Provider*, o lado que pede a configuração. O padrão é simples no papel e cheio de detalhes na prática.

- **A assinatura depende de DNS.** O provedor confere a requisição com uma chave pública publicada num registro TXT, num nome derivado do identificador do serviço. Cada ambiente (homologação e produção) tem domínio próprio, então cada um precisa do seu par de chaves e dos seus templates.
- **Um template não cobre todos os casos.** O validador oficial de templates recusa um CNAME no domínio raiz sem a opção que exige um host, e um template com essa opção não alcança o registro A do domínio raiz. A saída foi manter dois templates por ambiente.
- **Provedores interpretam o padrão de jeitos diferentes.** Um deles exige a assinatura sempre, com o parâmetro `sig` obrigatoriamente no fim da query, e ignora o parâmetro `state`, que o padrão prevê para devolver contexto ao serviço.
- **Detectar suporte envolve três chamadas externas**: uma consulta DNS sobre HTTPS, a leitura das configurações do provedor e a checagem do template. Uma falha de rede no meio não pode virar "seu domínio não suporta".

No SSL, o certificado é emitido pela Cloudflare for SaaS, o produto que deixa uma plataforma servir HTTPS em domínios de clientes. O status muda de forma assíncrona, e o polling por fila dava um fim arbitrário ao acompanhamento.

## A solução

### Assinar o que o provedor vai conferir

A query enviada ao provedor é assinada com RSA de 2048 bits, no esquema PKCS#1 v1.5 com SHA-256. A chave privada fica como segredo do Worker, e a pública é derivada dela em tempo de execução para ser publicada no TXT. Assim não existe uma segunda cópia da chave para sair de sincronia.

### Levar o contexto pelo caminho, não pelo `state`

Como um provedor ignora o `state`, coloquei o contexto assinado no **caminho** da URL de retorno. O caminho volta intacto em qualquer provedor. No retorno, o servidor confere a assinatura e redireciona a pessoa para a tela de onde ela saiu, com sucesso ou erro.

### Dizer por que não dá

A detecção devolve um motivo legível quando o domínio não suporta o fluxo: sem registro TXT, sem configurações, template não suportado, chave ausente ou provedor fora do ar. Falha de transporte cai sempre em "provedor indisponível", e o texto pede para tentar de novo em vez de afirmar que não há suporte. Sem chave configurada, o front volta ao fluxo manual sem mostrar erro.

### Trocar polling por evento, com uma rede de segurança

No SSL, o caminho rápido virou um **webhook** da Cloudflare. Ele é autenticado por um cabeçalho comparado em tempo constante e reconcilia o hostname daquela entrega na hora. Entrega de outra zona é ignorada. Se a reconciliação falhar, o webhook responde erro e não tenta compensar, porque existe um segundo caminho.

Esse segundo caminho é um **cron a cada 30 minutos** que pega até 200 domínios pendentes, dos mais antigos para os mais novos, e reconcilia cada um. Todo pendente ganhou um destino final: depois de 7 dias sem ativar, o cron remove o hostname na Cloudflare, marca o domínio como falho e avisa a pessoa por e-mail. Se a remoção falhar, nada é marcado, e o próximo ciclo tenta de novo. Isso evita declarar como falho um hostname que ainda existe do outro lado. Pendências antigas demais, acima de 14 dias, expiram sem e-mail, para não avisar alguém sobre algo que ele já abandonou.

## Um exemplo

Esta é a ideia da assinatura, em versão mínima com Web Crypto. Os nomes e valores são fictícios.

```ts
async function signApplyQuery(params: Record<string, string>, privateKey: CryptoKey) {
  // O provedor reconstrói a mesma string, então a ordem precisa ser determinística.
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&');

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(query),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));

  // Um dos provedores só aceita `sig` como último parâmetro.
  return `${query}&sig=${encodeURIComponent(sig)}&key=_dck1`;
}

const query = await signApplyQuery(
  { domain: 'minhaloja.com.br', host: 'www', target: 'pages.example.net' },
  privateKey,
);
```

E o ciclo de vida do certificado de um domínio, do lado do servidor:

| Momento | Evento | O que acontece |
| --- | --- | --- |
| t=0 | pessoa conecta o domínio | hostname criado, status pendente |
| t=4 min | webhook chega | reconcilia na hora, status ativo |
| alternativa: webhook se perde | cron das 30 min | reconcilia e marca ativo no ciclo seguinte |
| dia 7 ainda pendente | cron | remove o hostname, marca falho, envia e-mail |
| remoção falha | cron | não marca nada, tenta no próximo ciclo |

## Resultado

A pessoa clica uma vez, confirma no painel do provedor e volta ao editor com o domínio conectado. Quem usa um provedor sem suporte segue o fluxo manual de antes, sem tela quebrada. O certificado fecha por evento na maioria dos casos, e o domínio que nunca ativa sai do limbo com um motivo e um aviso, em vez de ficar pendente sem dono.

## O que eu levo disso

Com um sistema de terceiro que confirma de forma assíncrona, use o evento como caminho rápido e um cron como rede de segurança. Os dois juntos são mais simples do que tentar tornar um deles infalível. E todo estado pendente precisa de um destino final escrito no código, senão ele vira uma fila invisível de coisas esquecidas.
