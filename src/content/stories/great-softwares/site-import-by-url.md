---
title: Importar um site inteiro por URL sem abrir uma porta para SSRF
summary: "Importar um site por URL faz o servidor baixar qualquer endereço que o usuário escolher, inclusive da rede interna. Bloqueei esses acessos e só aceito a cópia depois de abri-la num navegador real e ver que funciona."
project: great-softwares
order: 6
tags: [SSRF, Segurança, Cloudflare Workers, Browser Rendering, Parsing]
---

Uma agência tem um site institucional feito à mão, em HTML e um pouco de React, hospedado em algum lugar que ela quer abandonar. No Great Pages, ela cola o endereço e clica em importar. Por trás, meu servidor baixa o HTML, descobre cada CSS, script, fonte e imagem, guarda tudo no armazenamento e publica uma cópia que deveria funcionar igual. Para quem pede, é um botão. Para quem constrói, é um recurso que faz o servidor buscar qualquer URL que um usuário escolher.

## O problema

O Great Pages passou a aceitar sites completos em HTML, além das páginas montadas no editor. A importação por URL precisava trazer o site com fidelidade e, ao mesmo tempo, não virar uma ferramenta para alcançar a rede interna, nem copiar quem pediu para não ser copiado. Segurança e fidelidade puxam para lados opostos.

## Por que não era trivial

- **SSRF (Server-Side Request Forgery)**, o ataque em que alguém faz o servidor buscar por ele um endereço que deveria ser inalcançável. A URL pode apontar direto para a rede privada, ou responder com um redirect para ela depois de uma primeira resposta inocente.
- **Saber o que baixar vai muito além de `<img src>`.** Sites modernos referenciam arquivos em `source`, `video`, `srcset`, dentro de CSS com `url()` e `@import`, e em strings de JavaScript que só um navegador resolveria.
- **Alguns sites bloqueiam acesso automatizado** com páginas de desafio, e outros dizem no `robots.txt` que não querem robôs.
- **Baixar tudo não garante que funcione.** Aplicações de página única quebram por erro de hidratação (quando o HTML do servidor não bate com o que o React monta no cliente) ou por um módulo carregado sob demanda que ficou para trás.
- **Volume e tempo**: centenas de arquivos, cada um podendo ser enorme ou lento.

## A solução

### Redirect manual, revalidado a cada salto

O download usa `fetch` com `redirect: "manual"`. Cada `Location` volta pela mesma checagem antes de ser seguido: URL inválida, rede privada, rastreadores conhecidos e a zona de pré-visualização da própria plataforma são bloqueados. Há teto de saltos, teto de bytes (o declarado no `content-length` e o contado durante a leitura) e timeout por arquivo.

Seguir redirects à mão tem um efeito colateral: os cookies passam a ser problema meu. Mantenho um pote de cookies por origem e trato `max-age=0` como apagamento, porque alguns sites definem um cookie num salto e exigem esse cookie no seguinte.

### Descoberta por tokenização

HTML passa por um parser de eventos. CSS passa por um tokenizador, e só contam `url()` e `@import` de verdade, não um texto parecido dentro de um comentário. JavaScript passa por um tokenizador da linguagem, que extrai os literais de string e os template literals sem interpolação.

Uma string com cara de arquivo estático, como `"img/hero.webp"`, vira candidata. Se o caminho é absoluto ou começa com `./`, a resolução é direta. Se é relativo puro, ele vira um candidato especulativo, testado em mais de uma pasta, com um teto total de sondagens. Uma sondagem que falha não derruba a importação. Foi assim que a ferramenta passou a achar mídia que só o script referenciava.

### Respeito e bloqueio

O `robots.txt` é lido, e um bloqueio total vira uma recusa clara. Páginas de desafio de antibot são reconhecidas pelo título e pelo conteúdo, e a mensagem sugere baixar o código do site e usar a importação de arquivo, em vez de insistir. Selos e scripts que a hospedagem de origem injeta no HTML são removidos por análise da árvore e do CSS, não por busca de texto.

### Provar a cópia

Depois do download, o servidor abre a cópia num navegador remoto, num host de pré-visualização assinado, com viewport fixo. Ele rola a página, grava erros de console e compara o texto renderizado com o da origem, exigindo uma proporção mínima. A cópia é reprovada se aparecerem erros conhecidos de hidratação do React ou de falha ao carregar módulo dinâmico, ou se a navegação sair do host da cópia, sinal de que o site tentou voltar para a origem. Rotas internas de aplicações de página única são sondadas no mesmo navegador, para descobrir quais páginas o site realmente tem.

## Um exemplo

Linha do tempo de uma importação que tenta escapar para a rede interna (valores fictícios):

| t | Requisição | Decisão |
|---|---|---|
| 0 ms | `GET https://exemplo-agencia.com.br/` | permitido; resposta 301 para `/home` com `Set-Cookie: sid=abc` |
| 80 ms | `GET https://exemplo-agencia.com.br/home` com `Cookie: sid=abc` | permitido; HTML de 140 KB |
| 300 ms | tokenizador de JS acha `"assets/hero.webp"` | candidato especulativo, testado em `/assets/` e `/home/assets/` |
| 310 ms | `GET https://exemplo-agencia.com.br/r?to=interno` | resposta 302 para `http://10.0.0.5/admin` |
| 311 ms | checagem do `Location` | bloqueado: rede privada; arquivo marcado como não resolvido |
| 2,4 s | download termina dentro dos limites | cópia montada no armazenamento |
| 6,0 s | navegador abre a cópia no host de prévia | console limpo, texto renderizado compatível com a origem |
| 6,1 s | veredito | cópia aceita |

O ponto do exemplo está nos 311 ms: a primeira resposta foi inocente, e o desvio só aparece no segundo salto. Com `redirect: "follow"`, o `fetch` teria seguido sozinho e eu nunca veria o endereço interno.

## Resultado

A importação por URL recusa o que não deve fazer, explica o motivo em linguagem clara e só aceita uma cópia que passou numa verificação real de navegador. Tudo roda dentro de limites declarados de arquivos, bytes, saltos e tempo. Na publicação, o mesmo raciocínio vale: um site com roteamento no cliente é verificado contra o caminho real em que vai morar, inclusive numa rota profunda, antes de o publicador aceitar.

## O que eu levo disso

Para qualquer "baixe esta URL", faça o redirect à mão e revalide cada salto. Para qualquer "copie isto", não confie no download: abra a cópia e veja se ela funciona.
