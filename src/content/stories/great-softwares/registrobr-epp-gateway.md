---
title: Um gateway HTTP para falar EPP com o Registro.br sem perder a sessão
summary: "O Registro.br só conversa por uma sessão longa com login único, e a API do Great Domains roda em funções que vivem segundos. Escrevi um gateway que segura essa sessão e deixa o resto do sistema falar com ele por HTTP comum."
project: great-softwares
order: 18
tags: [EPP, Registro.br, TypeScript, TLS, Node.js]
---

Um cliente digita `minhaloja.com.br` na busca do Great Domains e quer saber, em menos de um segundo, se o domínio está livre. A API que responde roda em Cloudflare Workers, que falam HTTP e vivem poucos segundos. Do outro lado está o Registro.br, que não tem API REST. Ele fala EPP, um protocolo de sessão que exige conexão aberta, certificado de cliente e login. Os dois mundos não se encaixavam, e eu precisava de uma peça no meio.

## O problema

EPP (Extensible Provisioning Protocol, RFC 5730) é o protocolo que registros de domínio usam para receber pedidos de registradores. Cada mensagem é um XML precedido por um cabeçalho binário de 4 bytes com o tamanho total. Tudo trafega numa conexão TCP com TLS mútuo, em que o cliente também apresenta um certificado. O Registro.br adiciona extensões próprias para `.br`, como `brdomain` e `brorg`, que carregam CPF ou CNPJ do titular e os tickets de registro.

Um Worker não consegue segurar essa conexão. Ele nasce numa requisição, responde e morre. Abrir TLS, fazer login e mandar um comando a cada busca seria lento e, pior, agressivo com a credencial.

## Por que não era trivial

EPP é um protocolo de sessão. A conexão fica aberta, o login acontece uma vez e os comandos vão e voltam em ordem, um de cada vez. Pela política do Registro.br, repetir o login numa conexão que já está logada derruba a sessão. Então o código precisa saber exatamente em que estado está: conectando, pronto, ou drenando para fechar.

A senha também é delicada. Um processo em loop tentando logar com uma senha errada martela o registro e coloca a credencial da empresa em risco. Eu não queria descobrir o limite de tolerância deles em produção.

E as respostas do EPP são pouco úteis por si só. O código `2306` diz apenas "erro de política". A causa de verdade, como documento do titular inválido ou organização vinculada a outro provedor, vem num campo de extensão (`extValue`) que muita implementação ignora.

## A solução

Escrevi um serviço Node.js pequeno que expõe os comandos EPP como recursos HTTP simples: consultar disponibilidade, criar contato, registrar, renovar, ler a próxima mensagem da fila do registro. Ele escuta só em loopback (`127.0.0.1`), na mesma máquina do relay de IP fixo, e nunca fica exposto à internet.

### Uma sessão por processo

Uma classe de sessão abre a conexão no startup, lê o greeting do servidor (a mensagem de boas-vindas que lista as extensões suportadas) e mantém um keepalive: se a conexão fica ociosa, ela manda um `hello`. Se a conexão cai, reconecta com backoff exponencial começando em 1 segundo e com teto.

O login é preguiçoso. Ele só acontece na primeira requisição que precisa dele e de novo depois de uma reconexão. Enquanto a sessão está logada, o código simplesmente não tem caminho para logar outra vez.

### Um orçamento de login

Uma classe pequena conta as falhas de autenticação seguidas (código `2200` no EPP). Na terceira, ela bloqueia novas tentativas e o gateway passa a responder `503` sem encostar no registro, até alguém olhar. Cada reconexão permite no máximo uma tentativa de login.

A senha não vem de variável de ambiente. Só o caminho de um arquivo com permissão restrita vem, e o arquivo é relido a cada tentativa. Assim dá para rotacionar a senha sem reiniciar o processo.

### Fila FIFO com teto

Todos os comandos entram numa fila que executa um por vez, na ordem de chegada. A fila tem profundidade máxima e tempo máximo de espera. Se a sessão não está pronta ou o login está bloqueado, o pedido falha na hora com `503`, em vez de se acumular e estourar tudo quando a conexão voltar.

### Resposta de negócio sempre 200

Separei falha de transporte de resposta de negócio. Corpo inválido, sessão indisponível e timeout viram 4xx ou 5xx. Tudo que o registro respondeu vira `200` com um envelope de quatro formas: `ok`, `ticket` (o registro aceitou, mas o domínio ficou pendente de análise), `notFound` ou `failed`. Toda resposta carrega o código EPP cru e os identificadores de transação do cliente e do servidor (`clTRID` e `svTRID`), que é o que o suporte do registro pede quando algo dá errado. Nas falhas, o envelope traz as razões lidas do `extValue`.

### Recusar o que o protocolo não tem

O EPP do Registro.br não define comando para cancelar um ticket pendente, nem para descobrir o ticket de um domínio pelo nome. Em vez de fingir sucesso ou chutar um comando, a rota de cancelamento responde com um erro explícito sem ir ao registro, e deixei escrito por quê. Quem chama decide o que fazer com o ticket.

## Um exemplo

O núcleo do protocolo é o enquadramento. Cada mensagem tem 4 bytes com o tamanho total, contando o próprio cabeçalho, e uma leitura TCP pode trazer meia mensagem ou duas de uma vez:

```ts
const HEADER_BYTES = 4;

function encodeFrame(xml: string): Buffer {
  const body = Buffer.from(xml, "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(HEADER_BYTES + body.length, 0);
  return Buffer.concat([header, body]);
}

class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const total = this.pending.readUInt32BE(0);
      // TCP may deliver half a frame; wait for the rest instead of parsing garbage.
      if (this.pending.length < total) break;
      frames.push(this.pending.subarray(HEADER_BYTES, total));
      this.pending = this.pending.subarray(total);
    }
    return frames;
  }
}
```

E o que o chamador vê, para um registro de `.br` com o CNPJ do titular errado:

```json
{
  "outcome": "failed",
  "code": "EPP_2306",
  "eppResult": 2306,
  "message": "Parameter value policy error",
  "reasons": ["Documento do titular inválido"],
  "clTrid": "gdm-a91c-0042",
  "svTrid": "BR-7731905"
}
```

Sem o campo `reasons`, o painel só conseguiria dizer "erro de política". Com ele, a tela diz ao cliente o que corrigir.

## Resultado

O resto do sistema registra e consulta `.br` com chamadas HTTP comuns, sem saber que existe uma sessão TLS por trás. A credencial fica protegida contra login duplicado, contra loop de senha errada e contra rajadas. Validei contra o ambiente beta do Registro.br com um teste de integração que faz login de verdade e roda `domain:check`, sem gastar documento nem domínio reais num ambiente compartilhado.

## O que eu levo disso

Protocolo de sessão merece um adaptador com estado explícito, não chamadas soltas espalhadas pelo código. Proteger a credencial é parte do desenho, não um detalhe de operação. E, quando o protocolo não oferece um comando, a resposta honesta é recusar com clareza, não simular um sucesso que vai virar problema semanas depois.
