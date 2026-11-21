---
title: "Um contrato de checagens entre o rascunho da IA e a tela, com abstenção como resposta válida"
summary: "Uma resposta clínica podia citar a fonte certa e ainda assim trazer 25 mg onde o protocolo diz 0,25 mg. Coloquei checagens automáticas entre o rascunho da IA e a tela, e o que não passa vira abstenção em vez de resposta errada."
project: salte
order: 18
tags: [LLM, Validação de saída, TypeScript, Abstenção, Testes de regressão]
---

Num dos testes do motor clínico, a pergunta é a dose de um medicamento num cenário específico. O modelo gera uma resposta bem escrita, com uma citação ao protocolo do Ministério da Saúde. A citação existe, o protocolo existe, e o número que aparece na resposta também aparece no protocolo. Só que lá ele está dentro de "0,25 mg", e a resposta diz "25 mg". Uma verificação textual ingênua aprovaria. Esse foi o caso que me fez escrever o contrato.

## O problema

Num motor de evidência clínica, uma resposta pode estar errada de muitas formas além do número. Ela pode citar uma fonte que o texto nem usa. Pode citar a população errada, como um trecho pediátrico numa pergunta sobre adulto. Pode usar uma versão vencida do protocolo. Ou pode falar com o paciente ("procure atendimento") quando o leitor é um profissional.

Resposta sem lastro é pior que nenhuma resposta. Eu precisava de uma barreira entre o rascunho do modelo e a tela, e essa barreira não podia ser outro modelo.

## Por que não era trivial

Verificar que "o texto bate com a fonte" não é um `includes`. O português tem vírgula decimal e ponto de milhar. Há unidades compostas (`mg/kg/dia`), códigos com ponto, como os da CID (a classificação internacional de doenças), e números de ato normativo no formato `1.234/2024`.

Um `includes("25 mg")` encontra `25 mg` dentro de `0,25 mg`. Um `includes("10 mg")` encontra `10 mg` dentro de `10 mg/kg`, que é uma dose por quilo de peso e significa outra coisa. Esses são exatamente os erros que importam numa resposta de dose.

## A solução

### Checagens como funções puras

Escrevi o contrato como um conjunto fixo de checagens, cada uma uma função pura que recebe o rascunho e o registro do corpus e devolve violações. Nenhum modelo no caminho. Algumas regras:

- Citação que o texto não usa reprova. Id de citação repetido também, porque a interface numera as citações e o marcador ficaria ambíguo.
- Versão, data de publicação e situação da fonte são comparadas com o registro do corpus, nunca com o que a citação declara sobre si.
- Fonte crítica fora do prazo de conferência não sai.
- Frase dirigida ao paciente reprova.

### Um leitor de quantidades com vocabulário fechado

A parte mais delicada é ler números. Escrevi um tokenizador que separa o texto em quantidade, código, unidade fora do vocabulário e número malformado. O vocabulário de unidades é fechado. O ponto só é decimal quando o número não casa com a forma de milhar: `2.500` vale 2500, e `2.50` vale 2,5. Uma palavra desconhecida logo depois de um número vira `unknown-unit` e reprova, em vez de deixar o número passar solto.

### Fronteira de token nas duas pontas

Um trecho da fonte só sustenta uma quantidade da resposta se ela aparecer lá com fronteira nas duas pontas: nenhum dígito, vírgula decimal ou barra de unidade composta colado na borda.

### Reparar uma vez, depois se abster

Quando uma checagem reprova, o rascunho não vai para a tela. Se todas as violações são de formato ou de número, o motor tenta uma única reparação: devolve ao gerador o rascunho e as mensagens do contrato, e o resultado passa de novo por todas as checagens. Se falhar outra vez, a resposta vira uma abstenção com texto fixo e auditável. O log guarda só os códigos das checagens que falharam, nunca o texto do modelo.

## Um exemplo

O código abaixo é uma versão didática da checagem de fronteira, com nomes genéricos:

```ts
const BEFORE = /[\d,.]$/;      // "0," antes de "25 mg" muda o número
const AFTER = /^(\/|[\d,.]\d)/; // "/kg" depois de "10 mg" muda a grandeza

function supports(excerpt: string, quantity: string): boolean {
  let from = 0;
  while (true) {
    const at = excerpt.indexOf(quantity, from);
    if (at === -1) return false;
    const before = excerpt.slice(0, at);
    const after = excerpt.slice(at + quantity.length);
    if (!BEFORE.test(before) && !AFTER.test(after)) return true;
    from = at + 1;
  }
}
```

E os casos que ela precisa acertar. Todos os trechos e doses são fictícios e servem só para mostrar a regra de texto, não são orientação clínica:

| Trecho da fonte (ilustrativo) | Quantidade na resposta | Resultado |
| --- | --- | --- |
| "dose de 25 mg ao dia" | 25 mg | sustenta |
| "dose de 0,25 mg ao dia" | 25 mg | não sustenta |
| "10 mg/kg a cada 8 horas" | 10 mg | não sustenta |
| "até 2.500 mg por dia" | 2500 mg | sustenta, após normalizar o milhar |
| "10 mg/kg no início, depois 10 mg ao dia" | 10 mg | sustenta na segunda ocorrência |

O último caso é o motivo do laço. A primeira ocorrência de "10 mg" está colada em "/kg", e a segunda não. Parar na primeira daria um falso negativo e uma abstenção desnecessária.

## Resultado

Toda resposta entregue passou pelas mesmas checagens, e toda abstenção carrega um código fixo que a interface sabe mostrar. A abstenção também passou a cobrir outros caminhos honestos. Se o gerador estoura o limite de tokens de saída, o motor devolve a abstenção em vez de um erro. Se a bula do medicamento não tem posologia revisada, a pergunta de dose se abstém. Se a pergunta pede uma conta e faltam dados, a resposta lista os campos que faltam, com unidade, sem texto livre do modelo.

As checagens têm testes por regra, incluindo casos de regressão fixados para os formatos que já quebraram heurísticas antes, como números de registro e códigos da CID. Quando alguém mexe no tokenizador, esses casos dizem na hora o que mudou.

## O que eu levo disso

Trate "não sei" como um estado previsto do contrato, com código e texto próprios, e não como uma falha. Valide a saída de um modelo com código determinístico sempre que a regra puder ser escrita. E desconfie de qualquer verificação textual que não tenha um teste para a borda do token.
