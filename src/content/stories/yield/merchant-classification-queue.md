---
title: Transformar "MP*PADARIACENTRAL 03/06" em "Padaria Central, Alimentação"
summary: "O extrato chega com descrições como MP*PADARIACENTRAL, e sem tratá-las o gráfico de gastos já sai errado no primeiro acesso. Fiz a classificação em estabelecimento e categoria rodar em segundo plano, sem duplicar nada."
project: yield
order: 1
tags: [Cloudflare Queues, Classificação, PostgreSQL, Normalização de texto, Dead letter queue]
---

O usuário conecta o banco e, segundos depois, o Yield recebe um ano de extrato. Numa linha está `MP*PADARIACENTRAL`, em outra `PAG*PadariaCentral SAO PAULO`, numa terceira `PADARIA CENTRAL 03/06`. Para a pessoa é tudo a mesma padaria. Para o app, são três textos diferentes. Se eu não resolver isso, o gráfico de "quanto gastei com alimentação" fica errado logo no primeiro acesso, que é justamente quando o usuário decide se confia no produto.

## O problema

Cada transação precisa ganhar um estabelecimento conhecido e uma categoria. A descrição vem do banco com prefixo de intermediário de pagamento, número de parcela, cidade, código de autorização, acento ou sem acento. E isso precisa acontecer para centenas de transações de uma vez na primeira sincronização, sem atrasar a resposta ao webhook que trouxe os dados.

## Por que não era trivial

São dois problemas somados. O primeiro é de casamento de texto. Um padrão curto demais aparece dentro do nome de outro estabelecimento, de outra categoria: "BAR" está dentro de "BARBEARIA". Um padrão livre demais captura o que não devia. Eu precisava de um jeito de dizer "esta regra é mais específica que aquela" sem manter uma lista de exceções.

O segundo é de execução. Classificar é CPU mais consultas no Postgres, e não pode rodar dentro da requisição do webhook. Também precisa sobreviver a uma falha no meio sem duplicar nada e sem entrar em laço infinito de retentativa.

## A solução

### Uma normalização só, para tudo

Descrição bancária e padrão cadastrado passam pela mesma função: decompõe em NFD (a forma Unicode que separa a letra do acento) e remove os acentos, põe em minúsculas, troca tudo que não é letra ou dígito por espaço e colapsa espaços repetidos. Ela é idempotente, então normalizar um texto já normalizado não muda nada. Isso parece detalhe, mas evita a classe inteira de bugs em que o padrão foi salvo de um jeito e comparado de outro.

### Aliases com tipo e peso

Cada estabelecimento tem vários aliases. Cada alias tem um tipo de casamento (exato, prefixo, contém ou expressão regular) e um peso inteiro. Entre todos os aliases que casam com a descrição, vence o de maior peso; em empate, o mais antigo. Um alias específico e pesado ganha de um genérico e leve sem nenhuma regra especial.

Expressão regular fica restrita a padrões curados por administrador, com limite de tamanho e protegida por `try/catch`, para um padrão ruim não derrubar o lote inteiro. O usuário pode ter estabelecimentos próprios que sombreiam os globais. O detector é uma varredura linear sobre os aliases: dezenas de estabelecimentos contra um lote de transações é barato, e uma estrutura mais esperta só se paga quando o catálogo crescer bastante.

### Um pipeline em ordem fixa

Para cada transação: normaliza, detecta o estabelecimento, escolhe a categoria base (a do estabelecimento, senão a sugerida pelo agregador, senão "sem categoria"), aplica as regras do usuário em ordem de prioridade e grava o resultado numa camada separada do dado bancário. Nessa camada, campos que o usuário editou à mão ficam travados e nunca são sobrescritos por uma reclassificação.

### Fila com registro de jobs e fila de mensagens mortas

A sincronização quebra as transações novas em lotes de 300 e publica uma mensagem por lote no Cloudflare Queues. Cada mensagem tem uma linha de controle com estado: pendente, executando, concluído ou falho. O consumidor marca como executando, classifica, grava em blocos de 500 por upsert e conclui.

Se der erro, o consumidor grava a mensagem de erro e pede retentativa. Depois de três tentativas, a Cloudflare move a mensagem para uma dead letter queue (DLQ), a fila para onde vão as mensagens que esgotaram as tentativas. O mesmo consumidor escuta essa fila e só faz uma coisa: marca o job como falho em definitivo, para ele aparecer num painel administrativo em vez de girar para sempre.

## Um exemplo

Um catálogo fictício e a escolha pelo peso:

```ts
type Alias = { merchant: string; kind: 'exact' | 'prefix' | 'contains'; needle: string; weight: number }

const aliases: Alias[] = [
  { merchant: 'Padaria Central', kind: 'contains', needle: 'padariacentral',  weight: 50 },
  { merchant: 'Padaria Central', kind: 'contains', needle: 'padaria central', weight: 50 },
  { merchant: 'Bar do Zé',       kind: 'prefix',   needle: 'bar ',            weight: 10 },
  { merchant: 'Barbearia Navalha', kind: 'contains', needle: 'barbearia navalha', weight: 80 },
]

const normalize = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
   .replace(/[^a-z0-9]+/g, ' ').trim()

function detect(description: string): string | null {
  const text = normalize(description)
  const hits = aliases.filter(a =>
    a.kind === 'exact' ? text === a.needle :
    a.kind === 'prefix' ? text.startsWith(a.needle) : text.includes(a.needle))
  hits.sort((x, y) => y.weight - x.weight)
  return hits[0]?.merchant ?? null
}
```

Como cada descrição sai:

| Descrição bruta | Normalizada | Estabelecimento |
|---|---|---|
| `MP*PADARIACENTRAL` | `mp padariacentral` | Padaria Central |
| `PADARIA CENTRAL 03/06` | `padaria central 03 06` | Padaria Central |
| `BARBEARIA NAVALHA SP` | `barbearia navalha sp` | Barbearia Navalha |
| `BAR DO ZE` | `bar do ze` | Bar do Zé |

Note que o alias de prefixo `bar ` (com espaço) não casa com "barbearia", e mesmo que um alias genérico casasse, o peso 80 da barbearia ganharia. Ajustar uma classificação errada vira mudar um número numa linha de dado, não abrir um pull request.

## Resultado

A classificação roda fora do caminho do webhook. A entrega da fila é "pelo menos uma vez", mas como o upsert usa uma chave estável por transação, reprocessar uma mensagem não duplica nada. Falhas definitivas deixam rastro visível em vez de sumir ou girar em laço. E logo depois de cada job concluído, a mesma fila dispara a detecção de pagamentos recorrentes, que aproveita o estabelecimento recém-resolvido.

## O que eu levo disso

Retentativa e fila de mensagens mortas saem quase de graça quando o consumidor é idempotente. Se não for, cada retentativa é uma chance nova de corromper dado. Por isso a ordem certa é fazer a escrita idempotente primeiro e só depois colocar a fila na frente.
