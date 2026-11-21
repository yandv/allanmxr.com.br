---
title: Marcar medicamentos controlados em massa sem gravar nada primeiro
summary: "Para emitir receita de medicamento controlado no papel certo, o catálogo precisava saber quais itens são controlados, e marcar isso em massa tem peso regulatório. Cruzei o catálogo com a lista oficial da Anvisa numa ferramenta que mostra cada mudança antes de gravar."
project: salte
order: 21
tags: [TypeScript, PostgreSQL, Dry run, Migração de dados, Regulatório]
---

Um médico monta uma receita na plataforma, escolhe um medicamento de uso controlado e clica em imprimir. O papel que sai precisa ser o certo: medicamento controlado exige um receituário específico, às vezes com via retida, e a farmácia não aceita outro. Para a receita sair certa, o sistema precisa saber, item a item do catálogo, quais medicamentos são controlados e por qual lista. Essa informação não vinha pronta.

## O problema

A plataforma emite receitas a partir de um catálogo de medicamentos. Uma receita de controlado precisa do formato certo: notificação de receita, receita de controle especial ou receita com via retida, dependendo da lista. Quem define as listas é a Portaria 344 da Anvisa, a norma brasileira que relaciona as substâncias sujeitas a controle especial e o tipo de receituário de cada uma.

O catálogo não tinha essa marcação. A noção de "controlado" existia só como uma função isolada dentro de um dos serviços, sem ser a fonte única para as telas de receita. Eu precisava de uma marcação confiável no próprio catálogo e de uma regra única que todas as telas consultassem.

## Por que não era trivial

O catálogo tem muitas linhas, com nomes comerciais, nomes genéricos e formas farmacêuticas escritos de jeitos diferentes. A Portaria lista substâncias, não produtos. E o mesmo princípio ativo pode cair em listas diferentes conforme a forma: uma versão de uso oral pode ser controlada e a de uso tópico não. Há sais, sinônimos e exceções escritas em adendos, como o que manda uma substância de uma lista para o receituário de outra.

Marcar errado em massa é caro de desfazer. E o erro não é simétrico. Uma marcação mais restritiva do que a lei gera um papel a mais. Uma marcação mais frouxa deixa a receita sair inválida.

## A solução

Separei o trabalho em duas peças: um casador puro e uma ferramenta de linha de comando que só roda em dry run, ou seja, calcula tudo e escreve relatórios, sem tocar no banco.

### O casador

O casador indexa as substâncias da norma, com nomes e sinônimos normalizados (sem acento, sem parênteses, em minúsculas), pelo primeiro token. Para cada linha do catálogo, procura o trecho mais longo que casa e consome os tokens usados, para que um nome composto não case duas vezes. Ele devolve um de três vereditos:

- `MARKED`: controlado, com a lista, o receituário e a base da decisão.
- `REVIEW`: a regra exige uma pessoa olhar, por palavras desconhecidas ou candidatos conflitantes.
- `NONE`: não controlado, incluindo as exceções previstas na própria norma.

Quando o nome comercial e o genérico apontam listas diferentes, vale a mais restritiva. Uma decisão humana de revisão, guardada num arquivo versionado com quem revisou e quando, tem prioridade sobre o casador.

### A ferramenta que se recusa a rodar

Antes de olhar o catálogo, a ferramenta confere a fonte: a norma, a versão do anexo e o hash do arquivo. Se não bate com o esperado, ela para. Depois lê o catálogo e escreve só relatórios: o que seria marcado e uma fila de revisão agrupada por genérico, com os candidatos e as palavras desconhecidas. O SQL de aplicação e o de reversão são gerados a partir do mesmo resultado, e a amostra para conferência usa semente fixa, então o relatório é reproduzível.

### Falhar fechado

Depois da carga, a regra de prescrição é uma função pura. O tipo de receita vem da marcação do receituário e só recorre à lista quando não há marcação. Linha ainda em revisão conta como controlada, pela lista mais restritiva, e a interface avisa que a classificação não foi confirmada. Se a carga nem foi registrada, o sistema não presume que tudo é simples.

## Um exemplo

A tabela mostra como o casador trata linhas típicas. Os produtos, substâncias e listas são fictícios e servem só para ilustrar as regras de casamento, não para classificar nenhum medicamento real:

| Linha do catálogo (ilustrativa) | Veredito | Por quê |
| --- | --- | --- |
| "Produto A 10 mg comprimido (substância X)" | `MARKED`, lista C1 | X consta na lista C1 |
| "Produto B gel 0,05% (substância Y)" | `NONE` | a norma exclui Y em uso tópico |
| "Produto C cápsula (substância Y)" | `MARKED`, lista C2 | Y oral consta na C2 |
| "Produto D (cloridrato de substância Z)" | `MARKED`, lista B1 | sal normalizado para Z |
| "Produto E composto (substância W + vitamina)" | `REVIEW` | palavra desconhecida ao lado de candidato |
| "Produto F (nome comercial em C1, genérico em C2)" | `MARKED`, lista C1 | conflito resolvido pela mais restritiva |

E a regra de prescrição depois da carga, em versão simplificada:

```ts
type Row = { prescriptionType?: PrescriptionType; list?: ControlList; status: "marked" | "review" | "none" };

function prescriptionFor(row: Row, loadRegistered: boolean): PrescriptionType {
  if (row.prescriptionType) return row.prescriptionType;
  // linha em revisão ainda pode ser controlada: errar para o lado restritivo
  if (row.status === "review") return MOST_RESTRICTIVE;
  if (row.list) return typeForList(row.list);
  // sem carga registrada, "sem marcação" não significa "simples"
  if (!loadRegistered) return MOST_RESTRICTIVE;
  return "simple";
}
```

O que mais me ajudou foi a fila de revisão agrupada por genérico. Em vez de revisar centenas de linhas uma a uma, a pessoa decide uma vez por princípio ativo, e a decisão vale para todas as apresentações dele.

## Resultado

A marcação ficou auditável. Antes de gravar uma linha, dá para ver o que mudaria, por quê e quem aprovou cada exceção. O SQL de reversão existe antes da escrita. E o tipo de receita não depende de cada tela: todas consultam a mesma regra, que erra para o lado seguro quando não tem certeza.

## O que eu levo disso

Para qualquer carga em massa com peso regulatório, entregue primeiro o relatório e o SQL de reversão, e só depois a escrita. Faça a ferramenta conferir a fonte e se recusar a rodar quando ela não bate. E quando o erro não é simétrico, escreva o padrão do sistema do lado em que errar custa menos.
