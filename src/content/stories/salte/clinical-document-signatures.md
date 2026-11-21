---
title: Assinatura eletrônica de documento clínico que um perito consegue conferir
summary: "Termo de consentimento assinado por link só vale se alguém, anos depois, conseguir provar quem assinou e que o arquivo não mudou. Montei duas trilhas de assinatura, com um dossiê de evidências que qualquer perito confere recalculando um hash."
project: salte
order: 9
tags: [Assinatura eletrônica, ICP-Brasil, PDF, SHA-256, Cloudflare R2, Lei 14.063]
---

Uma paciente vai começar um tratamento e a clínica precisa do termo de consentimento assinado. Ela não está na recepção. A secretária sobe o PDF, a paciente recebe um link por e-mail, digita um código que chegou no celular e assina do sofá de casa. No mesmo dia, o médico assina a receita com o certificado digital dele. Os dois documentos parecem resolvidos. A pergunta que me guiou foi outra: se daqui a três anos alguém contestar aquela assinatura, o que a clínica tem para mostrar?

## O problema

A Salte é um ERP para clínicas, e documento clínico passa por ele o tempo todo: termos, atestados, receitas, laudos. Um botão "assinar" que só grava um "sim" no banco não prova nada. Num questionamento, a clínica precisa demonstrar três coisas: quem assinou, como essa pessoa foi identificada e que o arquivo assinado é exatamente o arquivo que ela viu.

Além disso, nem toda assinatura é igual. A Lei 14.063/2020 separa a assinatura eletrônica avançada, que exige vínculo inequívoco com o signatário e controle exclusivo do meio de assinatura, da assinatura qualificada, feita com certificado ICP-Brasil (a infraestrutura de chaves públicas oficial do país). Uma receita do médico e um termo assinado pela paciente pedem caminhos diferentes.

## Por que não era trivial

O primeiro obstáculo é que a paciente não tem conta no sistema. O link que ela recebe é a única credencial, então ele não pode ser adivinhável nem servir sozinho para assinar.

O segundo é a integridade. Se eu "carimbo" a assinatura dentro do próprio PDF, mudo os bytes do arquivo, e o hash do original deixa de bater. Preciso de uma cópia final legível que não destrua a prova do original.

O terceiro é o ambiente. A API roda em Cloudflare Workers, sem sistema de arquivos e com limite de memória. Gerar PDF ali exige cuidado com fontes e com caracteres que a fonte padrão não sabe desenhar: um acento exótico no nome do signatário não pode derrubar o selo com erro 500.

## A solução

### Duas trilhas, uma por tipo de assinatura

Cada signatário tem um tipo. O eletrônico assina pelo portal público, com verificação por código. O qualificado assina com certificado ICP-Brasil em nuvem, por meio de um provedor de assinatura: a autorização usa OAuth com PKCE (uma extensão do OAuth que impede que um código de autorização interceptado seja trocado por outra pessoa) e o resultado é um PDF assinado no padrão PAdES.

O signatário também carrega a forma de representação: ele mesmo, responsável legal, procurador ou curador. Isso entra no dossiê, porque "quem assinou" e "em nome de quem" são perguntas diferentes.

### O link não basta, o código decide

O token do link tem 32 bytes aleatórios, o mesmo nível de entropia de um id de sessão. O link vale 30 dias. Abrir o link não assina nada: o signatário pede um código, que chega por e-mail ou SMS e vale cinco minutos. É esse código de vida curta que cumpre o requisito de controle exclusivo da assinatura avançada. Para atendimento presencial, existe um terceiro método de verificação.

Se o token precisa ser trocado, o signatário mantém uma referência de recuperação estável, de 16 bytes. Ela serve para achar o pedido de assinatura, não para assinar. O código enviado continua sendo a porta.

### Hash do original antes de guardar

Quando o PDF chega, confiro os primeiros bytes (`%PDF-`) antes de qualquer gravação, porque o cabeçalho de tipo enviado pelo cliente não merece confiança. Em seguida calculo o SHA-256 do arquivo e só então guardo o original no R2, o armazenamento de objetos da Cloudflare. Esse hash é a âncora de toda a prova. O original nunca é reescrito.

### Uma trilha de eventos que só cresce

Cada passo vira um evento com horário e IP: criado, enviado, visualizado, código enviado, código errado, código verificado, assinado, concluído, recusado, expirado, cancelado, consentimento revogado. Os eventos não são editados. Eles formam a história que o dossiê imprime.

### O selo: o original mais uma página de manifesto

Quando todos assinam, gero a cópia selada: o original com uma página de manifesto acrescentada no fim. O manifesto lista o SHA-256 do original, a identidade de cada signatário, o método de verificação, IP, horários e a trilha completa de eventos. A integridade não depende de confiar no manifesto. Basta recalcular o hash do original guardado e comparar com o valor impresso.

O selo é gerado uma vez só. A chave do arquivo selado tem índice único, então duas conclusões simultâneas não produzem duas cópias diferentes. Para rodar dentro do Worker, o manifesto usa apenas a Helvetica padrão, e todo caractere fora da codificação dela é trocado antes de desenhar.

### O que ficou preparado, e não fingido

Carimbo do tempo confiável (RFC 3161, um padrão em que uma autoridade atesta o instante em que um hash existia) tem valor jurídico de verdade só quando vem de uma autoridade credenciada na ICP-Brasil. Deixei uma interface pronta para plugar essa autoridade sem mexer no fluxo de selo, mas ela não faz nada até o contrato existir. Preferi não usar um carimbo gratuito qualquer, que daria aparência de prova sem o peso dela.

## Um exemplo

Uma linha do tempo fictícia de um termo de consentimento com uma signatária:

| Momento | Evento | O que fica registrado |
| --- | --- | --- |
| 09:02 | Recepção sobe o PDF de 180 KB | Hash `3f9a…c41e` calculado, original guardado |
| 09:02 | Pedido criado e enviado | Link com token novo, válido por 30 dias |
| 19:40 | Paciente abre o link no celular | Visualizado, com IP e aparelho |
| 19:41 | Pede o código por SMS | Código enviado, expira às 19:46 |
| 19:43 | Digita um dígito errado | Código errado |
| 19:44 | Digita o código certo | Código verificado |
| 19:44 | Assina | Assinado, concluído, cópia selada gerada |

Anos depois, a conferência é mecânica:

```ts
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// o manifesto imprime o hash; o original continua intacto no armazenamento
async function originalIsIntact(original: ArrayBuffer, hashOnManifest: string) {
  return (await sha256Hex(original)) === hashOnManifest;
}
```

Se alguém tivesse trocado uma vírgula do termo depois da assinatura, o hash recalculado seria outro, e a trilha de eventos mostraria exatamente quando e de onde cada passo aconteceu.

## Resultado

A clínica passou a assinar documentos sem papel, com a paciente em casa ou o médico no consultório, e cada assinatura vem com um dossiê que se explica sozinho. O controle de acesso acompanha: receita e atestado só são lidos por quem os criou ou por quem tem permissão para ver registros de outros profissionais. PDFs de assinaturas canceladas são apagados depois de sete dias, e quem tenta abri-los recebe 410, que diz "existiu e foi removido" em vez de "nunca existiu".

## O que eu levo disso

Prova não é um campo booleano, é uma história que outra pessoa consegue reconstruir sem confiar em mim. Guardar o original intacto, ancorar tudo num hash e registrar eventos que só crescem custa pouco no dia em que se escreve o código e vale muito no dia em que alguém pergunta. E quando uma peça ainda não existe de verdade, como o carimbo do tempo credenciado, deixo o encaixe pronto em vez de fingir que ela está lá.
