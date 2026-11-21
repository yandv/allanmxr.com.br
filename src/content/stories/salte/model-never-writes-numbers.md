---
title: Por que o modelo de IA nunca escreve um número clínico
summary: "Em saúde, um número inventado com confiança pela IA é o pior erro possível. Tirei os números da mão do modelo, e todo valor que o profissional lê vem da fonte citada ou de uma calculadora testada."
project: salte
order: 17
tags: [LLM, TypeScript, Zod, Calculadoras clínicas, Segurança de IA]
---

Um profissional de saúde pergunta ao motor de evidência clínica da Salte se um medicamento precisa de ajuste para um paciente com função renal reduzida. O motor responde em segundos, cita a bula e escreve um valor de depuração. O texto é fluente, a citação existe, e o número parece certo. O problema é que, num sistema que deixa o modelo de linguagem escrever dígitos livremente, não há como saber se aquele número veio da fonte, de uma conta ou de lugar nenhum.

## O problema

Em saúde, um número errado tem consequência real: uma dose, um escore de risco, um clearance de creatinina. O sintoma que eu queria eliminar era específico. O modelo escreve "70 mL/min" com total segurança, e o valor não tem origem rastreável. Nenhuma checagem posterior consegue distinguir com certeza um número copiado de um número inventado, porque os dois têm a mesma cara.

## Por que não era trivial

A primeira ideia de qualquer um é escrever no prompt "não invente números". O modelo obedece quase sempre. E é no quase que mora o risco.

Além disso, um número numa resposta clínica pode ter origens diferentes, cada uma com sua regra de confiança:

- o texto literal da fonte citada (uma bula, um protocolo);
- a própria pergunta ("paciente de 72 anos");
- o contexto do paciente que o profissional registrou;
- uma conta feita a partir desses dados.

A conta ainda precisa aceitar unidades diferentes (kg ou g, cm ou m, mg/dL ou µmol/L) sem errar a conversão. E precisa recusar uma entrada que o modelo "achou" mas que não está em lugar nenhum.

## A solução

Inverti a responsabilidade. O modelo nunca escreve dígito. Ele escreve um rascunho com lacunas nomeadas, e o código preenche cada lacuna a partir de uma origem verificável.

### Dois tipos de lacuna

Uma lacuna de citação pede "o n-ésimo número literal do trecho citado". O código vai ao trecho, extrai o token e coloca no texto. Se o trecho não tem aquele número, a lacuna não resolve.

Uma lacuna de cálculo pede "o resultado da calculadora que o motor executou". O modelo não faz a conta. Ele só indica qual execução quer mostrar.

### Calculadoras como funções puras

Cada calculadora é uma função pura, definida por um construtor que obriga a declarar versão, referência bibliográfica (DOI ou PubMed), faixas válidas, unidades e de onde cada campo pode vir: da pergunta, do contexto do paciente, de um trecho de fonte ou da data de hoje. São dezenas delas, agrupadas por área, cada uma com seus testes.

Antes de rodar, o executor confere cada entrada contra a evidência. Um campo booleano só vale se vier acompanhado de uma citação literal da pergunta ou do contexto. Uma quantidade só vale se estiver no texto. A unidade é convertida pela definição do campo, não pelo modelo. Entrada que não confere conta como faltando, e o motivo vai para o rastro da resposta.

### Uma checagem que reprova dígito solto

Depois do rascunho, uma função pura procura qualquer dígito fora de lacuna. Isso inclui subscrito, sobrescrito e número por extenso ("setenta"). Também reprova lacuna que aponta para citação inexistente e marcação malformada. O texto final só existe se essa checagem passar.

### Cálculo de dose desligado por padrão

As calculadoras de dose exigem liberação dupla: o cliente precisa estar habilitado e o pedido precisa trazer a permissão correspondente. Sem as duas, a calculadora nem aparece no catálogo que o modelo enxerga, e qualquer lacuna que tente usá-la é reprovada.

## Um exemplo

Um exemplo ilustrativo, com valores fictícios. Ele mostra o mecanismo, não uma orientação clínica.

O modelo devolve este rascunho:

```text
A depuração estimada é {{calc:run1}}, pela fórmula de Cockcroft-Gault [[run1]].
A bula indica ajuste quando a depuração fica abaixo de {{q:c2:1}} [[c2]].
```

O motor resolve as lacunas assim:

```ts
type Evidence = { quote: string; value: number; unit: string };

function cockcroftGault(age: number, weightKg: number, creatinineMgDl: number, female: boolean) {
  const base = ((140 - age) * weightKg) / (72 * creatinineMgDl);
  return female ? base * 0.85 : base;
}

// entrada só vale se a citação literal existir na pergunta ou no contexto
function accept(field: Evidence, sourceText: string): number | null {
  return sourceText.includes(field.quote) ? field.value : null;
}

const question = 'Homem fictício, 70 anos, 60 kg, creatinina 2,0 mg/dL.';
const age = accept({ quote: '70 anos', value: 70, unit: 'year' }, question);
const weight = accept({ quote: '60 kg', value: 60, unit: 'kg' }, question);
const creatinine = accept({ quote: '2,0 mg/dL', value: 2.0, unit: 'mg/dL' }, question);

const run1 = age && weight && creatinine
  ? cockcroftGault(age, weight, creatinine, false) // ≈ 29 mL/min
  : null; // falta evidência: a lacuna não resolve e a resposta vira abstenção
```

A lacuna `{{q:c2:1}}` pega o primeiro número do trecho citado da bula, por exemplo "30 mL/min" em "reduzir a dose se a depuração for inferior a 30 mL/min". O texto final fica:

> A depuração estimada é 29 mL/min, pela fórmula de Cockcroft-Gault. A bula indica ajuste quando a depuração fica abaixo de 30 mL/min.

Se o modelo tivesse escrito "29" direto no rascunho, a checagem de dígito solto reprovaria a resposta inteira. Se o peso não estivesse na pergunta, a calculadora não rodaria, e o profissional receberia uma abstenção explicando o dado que faltou.

## Resultado

O número que o profissional lê tem origem verificável: ou é literal de uma fonte citada, ou saiu de uma função com referência bibliográfica e testes. O modelo continua escrevendo o texto, que é onde ele é bom. Mas um valor errado passou a ser um caso em que o contrato bloqueia a resposta, não um caso em que a resposta sai.

O preço é aceitar que algumas respostas viram abstenção quando uma lacuna não resolve. Em saúde, considero esse o lado certo do erro.

## O que eu levo disso

Quando o erro de um campo é caro, tire o campo do modelo. Peça um esqueleto com lacunas nomeadas e preencha por código, registrando a origem de cada valor. Prompt reduz a frequência do erro. Arquitetura muda o tipo de erro que é possível.
