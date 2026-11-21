---
title: Edição colaborativa num Durable Object, sem perder trabalho e com escrita mínima
summary: "Para várias pessoas editarem a mesma página do Great Pages ao mesmo tempo, construí salas em Durable Objects com servidor autoritativo. Depois medi em teste o custo de escrita no SQLite e ajustei o desenho até reabrir uma página cair de 659 linhas gravadas para 2."
project: great-softwares
order: 1
tags: [Durable Objects, WebSocket, Colaboração em tempo real, SQLite, Custo]
---

Imagine uma agência montando a landing page de um cliente. A designer ajusta as cores do topo enquanto o redator troca o texto do formulário, cada um no seu computador. Num editor feito para uma pessoa só, os dois clicam em salvar com dez segundos de diferença, e quem salvou por último vence: o trabalho do outro some sem aviso. Era esse o cenário que a edição em tempo real precisava tornar impossível.

## O problema

O editor visual do Great Pages nasceu para uma pessoa só. Ele abria a página, guardava tudo em memória e, ao salvar, mandava o documento inteiro de volta. Com duas pessoas, isso é uma corrida: o último documento enviado sobrescreve o anterior, mesmo que os dois tenham mexido em partes diferentes.

Eu precisava que várias pessoas editassem a mesma página ao mesmo tempo, vendo o cursor e a seleção umas das outras, sem perder trabalho. E havia uma segunda exigência, menos visível: o armazenamento escolhido cobra por **linha gravada**, então o custo de uma sala tinha que acompanhar o que as pessoas editam, e não quantas vezes elas entram e saem.

## Por que não era trivial

Quatro restrições de colaboração apertavam juntas.

- **Alguém precisa ordenar as mudanças.** Se cada cliente decide sozinho a ordem das edições, os estados divergem e nunca mais convergem.
- **Conexão longa custa caro.** Um processo acordado só para segurar um WebSocket ocioso é dinheiro jogado fora. Uma sala parada precisa dormir.
- **O editor roda em domínio próprio** para contas whitelabel (marca do parceiro, domínio do parceiro). O WebSocket para o serviço de colaboração é uma conexão cross-site, e o cookie de sessão não viaja junto.
- **Documento grande.** Uma página passa de centenas de KB com facilidade, e o valor de uma chave no armazenamento de um Durable Object tem teto de 2 MB.

E a cobrança do SQLite embutido tem regras pouco intuitivas:

- inserir numa tabela comum grava a linha e também a linha do índice da chave primária, mais uma por índice secundário;
- `DELETE` conta uma linha por linha apagada;
- um upsert cuja cláusula `WHERE` impede a atualização grava zero linhas;
- `setAlarm`, que agenda o próximo acordar do objeto, conta como uma linha.

## A solução

### Uma sala, um objeto

Um **Durable Object** é um objeto com estado e endereço único que a Cloudflare garante existir em uma só instância no mundo. Isso me deu de graça o ponto único de ordenação: criei um objeto por sala, identificada pela página e pela variação de teste A/B.

O objeto aceita os sockets pela API de WebSocket Hibernation. Com ela, o runtime pode tirar o objeto da memória enquanto a sala está quieta e acordá-lo quando chega uma mensagem. O keepalive é um `ping` respondido automaticamente com `pong` pelo próprio runtime, sem acordar o objeto.

### Servidor autoritativo e operações pequenas

O cliente não manda o documento. Ele manda lotes de operações (`SET`, `CREATE`, `DELETE`) com um identificador de lote. O servidor aplica last-writer-wins **por propriedade**: se duas pessoas mexem em propriedades diferentes, as duas mudanças ficam. Ele responde `ACK` ao autor e repassa as operações aos demais. A ordem dos blocos na página é só mais uma propriedade, então o servidor não tem nenhuma lógica de layout.

O documento vive no SQLite do próprio objeto, **uma linha por entidade** em vez de um blob único. Uma edição grava só a linha que mudou, e o teto de 2 MB por valor deixa de importar.

### Entrada por ticket

O navegador nunca vê o token de sessão. O servidor do editor, que lê o cookie `httpOnly`, pede um ticket ao serviço de colaboração. O serviço confere a sessão, decide o papel (editor ou só leitura, este quando o perfil é de leitura ou há um teste A/B rodando) e grava um ticket aleatório de 256 bits com validade de 60 segundos. O navegador abre o WebSocket só com esse ticket, e o resgate lê e apaga o ticket na mesma transação, para que ele nunca abra dois sockets.

### Detalhes do protocolo

- **Recusa com motivo.** O navegador não expõe o status HTTP de um upgrade de WebSocket recusado. Quando a sala não pode abrir (lotação, página apagada), aceito o socket, mando uma mensagem de erro com o motivo e fecho com um código próprio.
- **Frames depois do fechamento.** Depois que o servidor fecha um socket, o runtime ainda entrega frames que o cliente mandou antes. Marco o fechamento nos metadados do socket e descarto esses frames. O `readyState` não serve, porque ele também muda quando é o cliente que fecha, e um lote válido enviado logo antes seria jogado fora.
- **Recusa definitiva não apaga trabalho.** A sala grava de volta na API em segundo plano. Falha de rede reagenda com backoff de 5, 15, 60 e 300 segundos. Recusa definitiva (conta congelada, página apagada) não reagenda sozinha, mas também não descarta nada. A primeira versão limpava o estado nesse caso para a sala poder fechar. Troquei por quarentena com o documento guardado até alguém reabrir, porque perder trabalho do usuário é sempre pior do que manter um objeto vivo.

### A segunda volta do desenho: medir o que a sala grava

Com o protocolo funcionando, escrevi uma suíte que roda dentro do workerd, o runtime real dos Workers, e lê o contador de linhas gravadas que o SQLite do objeto expõe. Cada cenário (abrir sala, reabrir, um lote, uma rajada) ganhou um **teto** de linhas. A medição mostrou três ralos somados na primeira versão: o documento era apagado quando o último participante saía e regravado inteiro na entrada seguinte, o contador de sequência era gravado a cada lote, e cada lote rearmava o alarme da gravação de volta. Cada ajuste abaixo entrou junto com o teto novo, então o custo não volta sem um teste quebrar.

1. **A sala não reseta ao esvaziar.** Foi o maior ganho. Apagar o documento na saída parecia higiene, mas obrigava a reinserir tudo na reabertura. Agora a sala mantém o documento, relê a versão salva e faz upsert com guarda: entidade igual não grava nada, e só entidades que saíram do documento são apagadas. A sala expira depois de 90 dias vazia e sem trabalho pendente, com o alarme alinhado à meia-noite UTC para que várias entradas no mesmo dia não o regravem.
2. **Lease no contador de sequência.** Cada lote recebe um número que nunca pode repetir, nem depois de o objeto dormir e acordar. Reservo blocos de 100, gravo só o teto do bloco e mantenho o valor corrente em memória. Descartei usar o relógio como sequência, porque isso depende de relógio monotônico entre máquinas quando o objeto migra.
3. **Alarme só quando precisa.** A gravação de volta usa debounce de 3 segundos com teto de 15. O objeto lembra quando o alarme atual vence e só chama `setAlarm` se ele não cobre o novo prazo.
4. **Tabela WITHOUT ROWID.** Uma tabela comum guarda as linhas por um `rowid` oculto e mantém um índice separado para a chave primária. Com `WITHOUT ROWID`, a tabela vira a própria árvore da chave, e inserir grava uma linha em vez de duas. Salas novas nascem assim, e como nenhuma consulta usa `rowid`, voltar à versão anterior do código não exige migração.

## Um exemplo

Uma edição concorrente, com duas abas na mesma sala:

| Tempo | Aba A (designer) | Aba B (redator) | Servidor |
| --- | --- | --- | --- |
| t=0 | `SET hero.background = #0f172a` | | aplica, `seq=41` |
| t=8ms | | `SET form.title = "Fale com a gente"` | aplica, `seq=42` |
| t=10ms | recebe `ACK 41` e `OPS 42` | recebe `OPS 41` e `ACK 42` | |
| t=30ms | `SET form.title = "Contato"` | | aplica, `seq=43`, vence por ser a última na mesma propriedade |

Propriedades diferentes nunca brigam, e a mesma propriedade tem um vencedor determinístico que as duas abas veem.

O lease do contador, em versão mínima:

```ts
const SEQ_LEASE = 100;

class SeqCounter {
  private current: number;
  private ceiling: number;

  constructor(private sql: SqlStorage) {
    const row = sql.exec('SELECT ceiling FROM seq_lease').toArray()[0];
    // Retomar do teto, não do último valor usado: o que estava só em memória se perdeu.
    this.ceiling = Number(row?.ceiling ?? 0);
    this.current = this.ceiling;
  }

  next(): number {
    this.current += 1;
    if (this.current > this.ceiling) {
      this.ceiling = this.current + SEQ_LEASE - 1;
      this.sql.exec('INSERT OR REPLACE INTO seq_lease (id, ceiling) VALUES (1, ?)', this.ceiling);
    }
    return this.current;
  }
}
```

Em 250 lotes, isso grava o teto 3 vezes em vez de 250. Depois de uma hibernação no lote 130, a próxima sequência é 201: um salto, nunca uma repetição, e o editor aceita o salto.

E o efeito somado dos quatro ajustes, medido na suíte com um documento de teste de cerca de 200 entidades:

| Cenário | Primeira versão | Desenho final |
| --- | --- | --- |
| Reabrir sala com documento igual | 659 linhas | 2 linhas |
| Primeira abertura do documento | 455 linhas | 242 linhas |
| Lote seguinte dentro da janela de flush | 3 linhas | 1 linha |
| Rajada de 50 `SET` | 150 linhas | 50 linhas |

## Resultado

A sala hiberna quando ninguém mexe, o estado não depende de banco externo no caminho quente, e o editor reconecta com um ticket novo sem expor credencial ao JavaScript do navegador. O custo por sala acompanha o que as pessoas de fato editam. As mensagens têm schema Zod validado contra os mesmos exemplos no serviço e no editor, e os testes rodam no runtime real: upgrade de WebSocket de verdade, sessão com dois participantes, sala recusada, reabertura e os tetos de linhas gravadas.

## O que eu levo disso

Servidor autoritativo com operações pequenas e idempotentes resolve quase todo o resto da colaboração. Em plataforma que cobra por escrita, meço escrita como meço latência: com teste e teto por operação. E testar Durable Object só com fakes esconde problemas de integração: um erro na URL de encaminhamento ao objeto só apareceu quando passei a rodar a suíte no runtime real.
