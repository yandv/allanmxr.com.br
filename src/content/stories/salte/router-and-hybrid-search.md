---
title: "Escolher o protocolo antes de buscar o trecho: roteador e busca híbrida"
summary: "Numa pergunta clínica, o caso do paciente traz doenças que a pergunta não pede, e uma busca que olha tudo tende a escolher o protocolo errado. Separei a escolha do documento da busca dos trechos, e o motor cita o protocolo que a pergunta pede."
project: salte
order: 19
tags: [Cloudflare D1, SQLite FTS5, Busca híbrida, Embeddings, RAG]
---

Um profissional de saúde pergunta: "qual a meta de pressão para esse paciente?". No contexto do caso estão um paciente de 68 anos, diabetes tipo 2, doença renal crônica e uma lista de medicamentos. A pergunta é sobre hipertensão. Se a busca do motor de evidência clínica da Salte olhasse para tudo isso, podia voltar com trechos do protocolo de diabetes, citados direitinho, mas da fonte errada. Esse era o caso que a recuperação precisava acertar por desenho.

## O problema

Para citar o protocolo certo, o motor precisa primeiro achá-lo. A pergunta chega em linguagem natural, misturada ao caso do paciente. Uma busca que considera todas as doenças do caso devolve o documento que mais casa com o conjunto, e não o que responde à pergunta. Nos evals, as perguntas com caso clínico rico eram justamente as que mais puxavam a busca para o protocolo vizinho.

## Por que não era trivial

O corpus mora no Cloudflare D1, que é SQLite gerenciado. Eu tinha o FTS5 (o índice de texto completo do SQLite, que ordena por bm25, uma medida clássica de relevância por termos). E tinha três dificuldades.

A primeira era o vocabulário. Os PCDTs (Protocolos Clínicos e Diretrizes Terapêuticas, os documentos oficiais do SUS para cada doença) quase nunca escrevem "conduta" ou "manejo". Escrevem "tratamento" e "abordagem terapêutica". E uma palavra genérica como "tratamento" aparece em quase todo trecho, o que achata o bm25. A conduta central do protocolo ficava fora das primeiras posições.

A segunda era o roteador. O modelo que interpreta a pergunta tendia a jogar as doenças do paciente nos termos de busca.

A terceira era o acento. Quem digita no celular escreve "hipertensao". O documento diz "Hipertensão".

## A solução

Dividi o problema em três camadas, cada uma fazendo o mínimo.

### Um roteador com vocabulário estreito

Um modelo classifica a pergunta (conduta, medicamento, cálculo ou codificação) e extrai a condição e os aspectos pedidos. Dois ajustes fizeram diferença.

Primeiro, a condição é só a doença que a pergunta atual pede, nunca as outras doenças descritas no caso. O roteador nem vê os dados do paciente: vê apenas se eles existem.

Segundo, a lista fechada de aspectos é o vocabulário que os protocolos usam como título de seção: tratamento, meta, critérios, monitoramento, suspensão. Quando a lista era generosa demais, termos como "dose" e "ajuste" puxavam a pergunta para o lugar errado. Menos vocabulário, menos invenção.

### Escolher o documento sem modelo

O documento sai de um alias normalizado (minúsculo, sem acento, por palavra inteira) citado na pergunta ou na condição. Um alias que é parte de outro alias encontrado vale menos. Assim, "hipertensão" não puxa o protocolo de hipertensão arterial quando a pergunta diz "hipertensão pulmonar". Se a pergunta cita pelo nome um protocolo que nenhum documento vigente tem, o motor se abstém em vez de procurar em outro.

### Texto completo mais vetor

Dentro do documento escolhido, o FTS5 devolve um pool de 40 trechos ordenados por bm25, com peso maior para o título da seção do que para o corpo. Se o pool tem mais de 8, um embedding da pergunta reordena os trechos por similaridade de cosseno e ficam os 8 melhores. O bm25 acha o vocabulário. O vetor recupera a conduta central que a palavra genérica escondia.

### Escolher o tokenizador por teste

Em vez de escolher a configuração do FTS5 por opinião, escrevi um teste que cria tabelas temporárias com cada tokenizador e mede o que importa para o meu caso. Rodei no D1 local e repeti no remoto.

## Um exemplo

O teste do tokenizador é curto. Esta é uma versão simplificada:

```ts
const cases = [
  { tokenizer: 'unicode61 remove_diacritics 2', query: 'hipertensao', expected: 1 },
  { tokenizer: 'trigram', query: 'hipertensao', expected: 0 },
  { tokenizer: 'trigram', query: 'perten', expected: 1 },
  { tokenizer: 'trigram remove_diacritics 1', query: 'hipertensao', expected: 1 },
];

for (const { tokenizer, query, expected } of cases) {
  const table = `probe_${crypto.randomUUID().replaceAll('-', '')}`;
  await db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(body, tokenize = '${tokenizer}')`);
  await db.prepare(`INSERT INTO ${table} (body) VALUES (?)`).bind('Hipertensão arterial').run();
  const { results } = await db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).bind(query).all();
  expect(results.length).toBe(expected);
  await db.exec(`DROP TABLE ${table}`);
}
```

O resultado virou esta tabela:

| Tokenizador | Acha sem acento | Acha substring |
| --- | --- | --- |
| `unicode61 remove_diacritics 2` | sim | não |
| `trigram` | não | sim |
| `trigram remove_diacritics 1` | sim | sim |

Escolhi `unicode61 remove_diacritics 2`. A busca é por palavra inteira, e o índice por trigrama ficaria maior sem trazer ganho real para perguntas clínicas.

Voltando à pergunta da abertura, o caminho com as três camadas ficou assim:

| Etapa | Entrada | Saída |
| --- | --- | --- |
| Roteador | "qual a meta de pressão para esse paciente?" | tipo: conduta; condição: hipertensão; aspecto: meta |
| Alias | "hipertensão" | protocolo de hipertensão arterial |
| FTS5 | condição + aspecto | 40 trechos por bm25 |
| Vetor | embedding da pergunta | 8 trechos, com a seção de metas no topo |

Diabetes e doença renal continuam no caso, e o gerador da resposta pode considerá-las. Elas só não decidem mais qual documento é lido.

O teste ainda revelou uma pegadinha do D1 remoto: criar a tabela virtual junto com outros comandos numa única chamada da linha de comando falha. Por isso cada comando vai separado.

## Resultado

A recuperação ficou determinística onde dá (a escolha do documento) e semântica só onde ajuda (a ordem final dos trechos). O motor cita o protocolo da doença que a pergunta menciona, não o das doenças vizinhas do caso. E a escolha do tokenizador não é opinião: é um teste que continua rodando e me avisa se alguma coisa mudar.

## O que eu levo disso

Meça o que o motor de busca faz com os seus dados antes de escolher a configuração. Limite o que o roteador vê: quanto menos contexto irrelevante, menos ele inventa. E não peça para um modelo decidir aquilo que uma tabela de aliases decide melhor.
