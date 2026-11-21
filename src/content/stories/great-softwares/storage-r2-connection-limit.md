---
title: Achar o teto de conexões do Worker medindo, para a cópia caber no prazo
summary: "Copiar as imagens de uma página com mais de cem arquivos, uma requisição por arquivo, consumia quase os 30 segundos de prazo da exportação. Medi o limite de conexões do Worker, reorganizei a cópia em lote e ela passou a terminar em poucos segundos."
project: great-softwares
order: 10
tags: [Cloudflare R2, Cloudflare Workers, Concorrência, waitUntil, Streaming]
---

Exportar uma página do Great Pages exige copiar cada imagem para um novo endereço no armazenamento. Numa página cheia de imagens, medindo o caminho por arquivo, só essa etapa consumia quase os 30 segundos que o cliente HTTP da exportação espera antes de desistir. Imagine a barra de progresso andando devagar e parando perto do fim com um erro de tempo esgotado: era isso que a cópia nova precisava evitar.

## O problema

As imagens moram no R2, o armazenamento de objetos da Cloudflare. Um Worker é dono do bucket e expõe operações de upload, cópia e exclusão. A exportação pedia uma cópia por requisição HTTP a esse Worker, uma por arquivo. Numa página com pouco mais de cem imagens, a cópia andava a menos de cinco arquivos por segundo, e paralelizar mais no chamador não mudava nada.

Havia um segundo risco no mesmo serviço. Uma escrita no R2 que só era aguardada podia ser interrompida no meio se o cliente desconectasse, sem exceção e sem log, e um arquivo publicado poderia simplesmente não existir.

## Por que não era trivial

- **Um Worker mantém no máximo seis requisições esperando cabeçalho de resposta ao mesmo tempo.** O serviço de armazenamento só respondia quando a transferência terminava, então os seis lugares ficavam ocupados. Mais paralelismo do lado de quem chama só aumentava a fila.
- **O binding do R2 obedece ao mesmo teto.** Com streaming, a leitura da origem fica aberta enquanto o destino escreve, então cada cópia em voo ocupa duas conexões. Acima do limite, o runtime fecha a resposta com um erro de limite de conexões.
- **Carregar o arquivo na memória não resolve.** Um lote de imagens grandes encosta nos 128 MB de memória de um Worker.
- **"Await" não garante que a escrita termina.** Quando o cliente desconecta, a plataforma pode encerrar a invocação, e a promise em voo morre junto.
- **A cópia por arquivo não era estrita.** Ela respondia sucesso mesmo quando a origem não existia ou quando algo falhava no meio do laço. Levada para uma fila, essa resposta confirmaria cópias que nunca aconteceram.

## A solução

### Copiar onde o bucket está

A operação de cópia passou a receber uma lista de pares origem e destino e executá-los pelos bindings, dentro do próprio Worker dono do bucket. O transporte HTTP por arquivo some. A cópia passa o corpo do objeto direto de um lado para o outro em streaming, sem materializar o arquivo em memória.

### Achar o número medindo

A documentação dava a pista, mas não dizia como o limite se comportava com cópias em streaming. Então medi em homologação, contra uma página real de teste, variando quantas cópias rodavam ao mesmo tempo. O resultado está no exemplo abaixo. Fixei seis por vez e deixei a medição escrita como comentário ao lado da constante, para ninguém subir o número achando que é conservador demais.

### Segunda passada para o que falhar

O que falha na primeira rodada é tentado de novo, um de cada vez, porque o modo de falha é pressão de conexão e a mesma cópia sozinha passa. Origem inexistente não é retentada, porque tentar de novo não muda nada. O cliente divide as cópias em invocações de 25 itens.

### Toda escrita entregue a `waitUntil`

Upload, cópia e exclusão passaram a ser registradas com `waitUntil`, o mecanismo que pede ao runtime para continuar trabalhando depois da resposta. O caminho feliz devolve a mesma promise, e quem chama continua aguardando como antes. A diferença é que, se o cliente desconectar, a escrita ainda tem até 30 segundos para terminar.

### Cópia honesta e verificação de existência

A cópia por fila ficou estrita: origem ausente ou falha no meio do laço viram erro com retry, porque a origem pode ser outra cópia que ainda não chegou. Também criei uma operação que, dado um lote de chaves, diz quais existem. Ela usa uma consulta por chave, e não uma listagem por prefixo, porque `foto.png` é prefixo de `foto.png.bak` e daria falso positivo. Com isso, quem produz um link confere que o arquivo existe antes de publicá-lo.

## Um exemplo

A medição que definiu o limite, com mais de cem imagens por rodada:

| Cópias simultâneas | Resultado |
| --- | --- |
| 25 | cerca de metade falhava |
| 15 | cerca de um quinto falhava |
| 10 | falhas intermitentes |
| 6 | todas as cópias, em todas as rodadas |

E o formato do laço, em versão mínima:

```ts
const PARALLEL_COPIES = 6; // cada cópia em streaming ocupa duas conexões

async function copyMany(bucket: R2Bucket, pairs: CopyPair[]) {
  const failed: CopyPair[] = [];

  for (let i = 0; i < pairs.length; i += PARALLEL_COPIES) {
    const chunk = pairs.slice(i, i + PARALLEL_COPIES);
    const results = await Promise.allSettled(chunk.map((pair) => copyOne(bucket, pair)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') failed.push(chunk[index]);
    });
  }

  // Falha por pressão de conexão some quando a cópia roda sozinha.
  for (const pair of failed) await copyOne(bucket, pair);
}

async function copyOne(bucket: R2Bucket, { from, to }: CopyPair) {
  const source = await bucket.get(from);
  if (!source) throw new SourceMissingError(from);
  await bucket.put(to, source.body, { httpMetadata: source.httpMetadata });
}
```

Na versão real, origem ausente sai da segunda passada e é reportada direto como falha.

## Resultado

A cópia que levava quase 30 segundos passou a terminar em poucos segundos, com algumas invocações em vez de uma requisição por arquivo, e a exportação cabe com folga no prazo do cliente. As escritas no R2 sobrevivem à desconexão de quem pediu, e a cópia por fila reporta o que realmente aconteceu.

## O que eu levo disso

Quando um limite de plataforma é um número, descubra o número medindo, no seu padrão de uso, e deixe a medição escrita ao lado do código. E não trate `await` como garantia de que uma escrita termina: se o dado importa, entregue a escrita ao runtime com `waitUntil`.
