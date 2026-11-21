---
title: Guardar o certificado A1 do lojista sem que o banco baste para usá-lo
summary: "Emitir nota fiscal exige guardar o certificado digital de cada lojista, e quem o roubasse poderia se passar pela empresa. Isolei as chaves num serviço à parte, e uma cópia do banco sozinha deixou de bastar para usá-las."
project: araute
order: 9
tags: [Criptografia, AES-GCM, Cloudflare Workers, PostgreSQL, NFS-e]
---

Quando um lojista liga a emissão automática de nota fiscal, ele faz upload do certificado A1 da empresa e digita a senha. A partir dali, toda nota que a Araute emitir em nome dele vai ser assinada com aquela chave privada. É a mesma chave que ele usa para assinar documentos fiscais em qualquer lugar. Se ela vazar, alguém consegue se passar pela empresa dele perante o fisco.

## O problema

Para emitir NFS-e (a nota fiscal de serviço eletrônica) em nome do lojista, preciso assinar o XML com o certificado A1 dele. O A1 é o certificado digital em arquivo da ICP-Brasil, a infraestrutura oficial de chaves públicas do país. Na prática, isso significa guardar a chave privada de muitos lojistas, por tempo indeterminado.

A pergunta de projeto foi direta: se alguém obtiver uma cópia do banco, ou explorar uma rota da API, isso basta para usar a chave de um lojista? A resposta tinha que ser não.

## Por que não era trivial

Não havia um HSM, o hardware dedicado que guarda chaves sem nunca entregá-las. O controle teria que ser de software, e precisava ser honesto sobre o risco que sobra.

O material sensível também passa por vários estágios: ingestão, decifragem, assinatura do XML e uso como certificado de cliente no transporte mTLS. Cada estágio é uma chance de a chave aparecer num log, num retorno de função ou numa variável que vive mais do que devia.

E o sistema é multi-tenant. Um erro de contexto, como o ID do lojista errado numa chamada, não pode resultar em assinar a nota de um lojista com a chave de outro.

## A solução

### Um serviço só para isso

A custódia é um Worker separado, sem rota HTTP pública. A API fala com ele por service binding, a chamada privada entre Workers da Cloudflare que não passa pela internet. Só esse serviço tem a chave-mestra, e o código de decifragem não existe na API. Isso é uma garantia mais forte que "a API não tem permissão": ela simplesmente não sabe decifrar.

### Criptografia em envelope

Cada versão de certificado ganha uma chave de dados nova, aleatória, de 256 bits. Ela cifra a chave privada com AES-256-GCM, um modo de cifra que também detecta qualquer alteração no texto cifrado. O nonce, o valor único por cifragem, é sempre gerado ali dentro e nunca aceito de quem chama.

A chave de dados, por sua vez, é cifrada pela KEK (a key encryption key, a chave-mestra que só embrulha outras chaves). No banco fica só o texto cifrado e a chave de dados embrulhada. Uma cópia do banco, sozinha, é ruído.

### O contexto faz parte da criptografia

O AES-GCM aceita um AAD, dados adicionais autenticados: informação que não é cifrada, mas entra no cálculo da tag de integridade. Uso o AAD para amarrar o envelope ao seu dono e ao seu uso: lojista, estabelecimento, versão do certificado, ambiente e finalidade.

Decifrar com qualquer outro contexto falha exatamente como falharia se um bit do texto cifrado tivesse sido trocado. Um erro de contexto deixa de ser um caminho de código que eu poderia implementar mal e passa a ser um erro de criptografia.

### Autorização de uso única

Antes de qualquer decifragem, uma política decide se aquele uso é permitido e emite uma autorização de uso único, com validade curta. Ela é consumida de forma atômica, numa transação com lock por credencial, e o consumo acontece antes de decifrar. Duas chamadas concorrentes com a mesma autorização não conseguem as duas passar.

### Decifrar uma vez, zerar sempre

A decifragem acontece uma vez por operação, em memória. A chave de dados e a chave privada em claro são zeradas num bloco `finally`, inclusive quando algo falha no meio. O material nunca aparece em log nem em retorno.

### Revogação fail-closed

Toda credencial nasce como "não verificada", e em produção o serviço se recusa a assinar enquanto não confirmar que o certificado não foi revogado. As fontes de revogação ficam numa lista fixa do serviço, nunca na URL que vem dentro do próprio certificado, para que um certificado malicioso não faça o serviço buscar um endereço arbitrário.

### Destruir e rotacionar

Para destruir uma credencial, apago a chave de dados embrulhada em vez da linha. O texto cifrado fica inútil e a trilha de auditoria continua lá. É o que se chama de crypto-shredding.

Para trocar a KEK, re-embrulho cada chave de dados com a nova, sem decifrar nenhuma chave privada.

## Um exemplo

A ideia central do envelope com AAD cabe em poucas linhas usando WebCrypto:

```ts
type EnvelopeContext = {
  tenantId: string
  establishmentId: string
  certVersion: number
  environment: 'production' | 'sandbox'
  purpose: 'xml_signature'
}

function encodeAad(ctx: EnvelopeContext): Uint8Array {
  // JSON com ordem fixa de campos: a codificação precisa ser única por contexto
  return new TextEncoder().encode(JSON.stringify([
    ctx.tenantId, ctx.establishmentId, ctx.certVersion, ctx.environment, ctx.purpose,
  ]))
}

async function openEnvelope(dataKey: CryptoKey, blob: Uint8Array, ctx: EnvelopeContext) {
  const iv = blob.slice(0, 12)
  const sealed = blob.slice(12)
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: encodeAad(ctx) },
    dataKey,
    sealed,
  )
}
```

Agora imagine o envelope do lojista `t_8f2a`, estabelecimento `e_01`, versão 3. Uma chamada chega com tudo certo, mas `tenantId: 't_91c0'` por causa de um bug a montante. O `decrypt` não devolve a chave do outro lojista nem um resultado parcial: lança erro, porque a tag não confere. A mesma coisa acontece se alguém tentar usar em produção um envelope criado para sandbox, ou usar a chave de assinatura para outra finalidade.

O detalhe da codificação importa. Se o AAD fosse a simples concatenação dos campos, contextos diferentes poderiam gerar os mesmos bytes (`"ab" + "c"` e `"a" + "bc"`). A codificação precisa ser injetiva: dois contextos diferentes, sempre dois AADs diferentes.

## Resultado

Uma cópia do banco, ou uma rota comprometida da API, deixou de ser suficiente para usar a chave de um lojista. Seria preciso alcançar o serviço de custódia em si, com a autorização de uso certa.

Também deixei escrito o que o desenho não cobre. A rotação de KEK resolve o vazamento da KEK com o banco íntegro. Se a KEK e o banco vazarem juntos, o remédio é destruir as credenciais e pedir aos lojistas que reenviem o certificado. Em testes, o certificado é sempre sintético, gerado com uma cadeia falsa, nunca um A1 real.

## O que eu levo disso

Quando possível, faça o erro de lógica virar erro de criptografia. Uma checagem de "esse ID pertence a esse lojista" pode ser esquecida num caminho novo. Um AAD não pode. E documentar o que a garantia não cobre é tão importante quanto o que ela cobre, porque um limite escrito se revisa e um limite implícito vira surpresa.
