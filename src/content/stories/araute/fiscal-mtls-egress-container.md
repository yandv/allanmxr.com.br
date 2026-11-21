---
title: "Integrar mTLS com o emissor fiscal a partir de um Worker: quatro camadas até a primeira resposta"
summary: "Na primeira emissão real contra o órgão emissor, ainda na integração, a resposta voltava vazia, sem mensagem de erro e com a suíte verde. Resolvi uma camada de cada vez, do certificado à plataforma, até a nota sair, e fiz os testes exercitarem o mesmo código que roda no container de saída."
project: araute
order: 8
tags: [mTLS, TLS, Cloudflare Workers, Containers, NFS-e]
---

A integração fiscal estava escrita, revisada e com a suíte verde. Faltava o passo que nenhum teste local substitui: emitir a primeira nota de verdade contra o ambiente do órgão emissor, antes de qualquer lojista usar a emissão. A resposta voltou vazia. Sem status útil, sem corpo, sem mensagem de erro. Só um "http 0" no log, que é a forma do transporte dizer que a conexão terminou antes de qualquer resposta. Não havia nada para ler, nem um código para pesquisar.

## O problema

Para emitir uma NFS-e (a nota fiscal de serviço eletrônica), a Araute precisa abrir uma conexão mTLS com o órgão emissor. mTLS é o TLS em que o cliente também apresenta um certificado. Aqui, esse certificado é o A1 do lojista, o certificado digital em arquivo emitido dentro da ICP-Brasil, a infraestrutura oficial de chaves públicas do país. Sem ele o servidor não aceita a nota.

A API roda em Cloudflare Workers, e a conexão saía de dentro do Worker. Era nessa saída que tudo morria.

## Por que não era trivial

"Resposta vazia" é o pior sintoma possível, porque é a soma de qualquer coisa que dê errado antes do primeiro byte. E aqui havia várias causas empilhadas. Corrigir uma não mudava o sintoma, só revelava a próxima.

Além disso, os testes provavam outra coisa. A suíte rodava em Node, onde o certificado de cliente é de fato apresentado. Deployado, o código rodava no runtime do Worker, que se comporta diferente. Verde no Node não dizia nada sobre o Worker.

## A solução

### 1. Cadeia completa, na ordem certa

A primeira camada era simples. A primeira versão apresentava só o certificado folha, o do lojista. Um A1 é emitido por uma autoridade intermediária, e o servidor não tem obrigação de conhecê-la. Sem a intermediária ele não consegue validar o cliente e encerra a conexão calado.

Passei a mandar a cadeia inteira. Com um detalhe: o arquivo do certificado traz os certificados em ordem arbitrária e com a raiz no meio. O TLS espera a folha primeiro, depois quem a emitiu, e assim por diante. A raiz fica de fora, porque o servidor já a tem.

### 2. TLS 1.2

A resposta continuou vazia. Instrumentei o callback de conexão segura e o log mostrou duas coisas estranhas: protocolo e cipher indisponíveis e o fim da conexão chegando no mesmo milissegundo do envio. Ou seja, nunca houve sessão TLS.

Reproduzi por fora com `openssl`. Forçando TLS 1.3, a conexão morria sem cipher negociado. Em 1.2, conectava. O servidor anuncia 1.3 mas não fecha o handshake nele, e o runtime prefere 1.3. Limitei a versão máxima a 1.2.

### 3. Fechar o lado de escrita

Ainda vazia. A requisição ia com `Connection: close`, e nesse modo o servidor só sabe que o pedido acabou quando o cliente fecha o lado de escrita do socket. O código escrevia o corpo e ainda não chamava `end()`. O servidor ficava esperando mais dados e derrubava a conexão no próprio timeout.

A prova veio de novo pelo `openssl`, que fecha a escrita ao terminar. O mesmo certificado recebia 405 no GET e 400 no POST, respostas de verdade. Pelo código da integração, silêncio.

O mais incômodo: o servidor falso dos testes respondia assim que lia o fim do cabeçalho, então nunca teria pego o `end()` ausente. Reescrevi o fake para só responder depois do fim da requisição e falhar por timeout se o `end()` sumir.

### 4. O runtime que ignorava o certificado

Com as três correções, a resposta continuava vazia. Foi aí que achei a causa de fundo. O `node:tls` do runtime do Worker aceita as opções `key` e `cert` sem erro e simplesmente não as usa. Os métodos que deveriam confirmar o handshake, como os que informam protocolo e se a conexão foi autorizada, não refletem o que de fato aconteceu.

E havia um segundo bloqueio. O servidor do órgão só pede o certificado de cliente por renegociação TLS, disparada depois do handshake inicial, conforme o caminho da URL. A pilha TLS da Cloudflare não renegocia. O recurso nativo de certificado mTLS da plataforma também não serve, porque só apresenta o certificado no handshake inicial.

Antes de concluir qualquer coisa, medi. Fiz o mesmo pedido por três caminhos dentro do mesmo Worker deployado, e só um deles devolveu uma resposta completa: um container Node.

## Um exemplo

A medição lado a lado foi o que encerrou a discussão. O mesmo pedido, ao mesmo caminho que exige renegociação:

| Caminho de saída | O que voltou |
| --- | --- |
| Socket cru do Worker | 0 byte, conexão encerrada |
| `fetch()` do Worker | 520, erro genérico de origem |
| Container Node | 403 completo, com corpo |

Um 403 completo parece pior que um 520, mas é o oposto. O status em si não importava naquela medição: importava que houve sessão TLS, renegociação e uma resposta real do servidor. Era o único caminho capaz de conversar com ele.

O transporte dentro do container ficou pequeno. A ideia central cabe aqui:

```ts
import { request } from 'node:https'

function sendWithClientCert(req: EgressRequest): Promise<EgressResponse> {
  if (!ALLOWED_HOSTS.includes(req.host)) throw new Error('host not allowed')

  return new Promise((resolve, reject) => {
    const out = request(
      {
        host: req.host,
        path: req.path,
        method: req.method,
        key: req.keyPem,        // chega em memória, por requisição, nunca em disco
        cert: req.chainPem,     // folha primeiro, raiz de fora
        timeout: req.timeoutMs,
      },
      (res) => collectBody(res).then(resolve, reject),
    )
    out.on('error', reject)
    if (req.body) out.write(req.body)
    out.end() // com Connection: close, sem isso o servidor espera para sempre
  })
}
```

O container não tem porta pública nem rota. Só o Worker de custódia fala com ele, por meio de um Durable Object, o objeto com identidade única que a Cloudflare usa para coordenar estado e, aqui, para endereçar o container. Ele mantém a própria lista de hosts permitidos, independente da que o Worker já aplica, e um teste falha se as duas divergirem.

## Resultado

A primeira nota saiu, e o harness de testes passou a exercitar exatamente a mesma função de saída que roda dentro da imagem do container. O teste deixou de provar outra coisa.

Houve custos. O container tem cold start de dezenas de segundos, então o timeout das chamadas fiscais passou a incluir essa margem, senão a consulta de reconciliação nunca chegava a sair. E a garantia de segurança da custódia mudou de forma: antes era "a chave nunca sai do isolate", agora é "a chave nunca sai da unidade de deploy da custódia". Escrevi a nova garantia em vez de fingir que a antiga continuava valendo.

Também ficou uma regra: mudança de transporte só é aceita depois de medida num Worker deployado. O ambiente de desenvolvimento local faz proxy dos sockets e não serve como evidência.

## O que eu levo disso

Teste verde num runtime diferente daquele em que o código vai rodar não é evidência. Quando o sintoma é uma resposta vazia, instrumentar o que existe e o que deveria existir vale mais que adivinhar: foi a ausência de uma sessão TLS no log que apontou o caminho. E, quando há suspeita da plataforma, a medição lado a lado no ambiente real decide mais rápido que qualquer leitura de documentação.
