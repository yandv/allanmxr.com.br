---
title: Os registradores exigiam IP fixo e Workers não têm IP fixo
summary: "Os registradores de domínio só aceitam chamadas de um IP cadastrado, e a API roda em Workers, que mudam de IP a cada requisição. Montei uma saída com IP fixo sem nenhuma porta aberta na internet, sem expor a credencial de revenda."
project: great-softwares
order: 19
tags: [Cloudflare Tunnel, nginx, Google Cloud, Redes, Segurança]
---

A primeira chamada de teste da API do Great Domains para a OpenSRS voltou recusada. O código estava certo, a credencial também. O problema era a origem: a OpenSRS só aceita requisições vindas de um IP que o revendedor cadastrou antes, numa allowlist. O Registro.br faz a mesma coisa. E a API inteira roda em Cloudflare Workers, que saem para a internet por endereços que mudam a cada chamada.

## O problema

O Great Domains registra domínios internacionais pela OpenSRS e domínios `.br` pelo Registro.br. Os dois exigem IP de origem fixo. Workers não oferecem isso: cada requisição pode sair de um data center diferente, com um IP diferente.

Eu precisava de um ponto de saída com endereço estável, por onde passassem todas as chamadas aos dois registradores.

## Por que não era trivial

O jeito óbvio é subir uma VM com IP fixo e um proxy. O jeito óbvio também é perigoso. Um proxy exposto na internet, com a credencial do revendedor configurada, é um botão de "registrar, renovar ou apagar domínios" para quem descobrir a URL.

Havia ainda três restrições:

- **Dois destinos com protocolos diferentes.** A OpenSRS fala HTTPS. O Registro.br fala EPP (o protocolo de sessão que registros de domínio usam), por meio de um gateway que roda na própria VM.
- **Máquina pequena e descartável.** É uma VM mínima. Se ela sumir, alguém precisa conseguir recriá-la do zero sem depender da memória de ninguém.
- **Nenhuma porta aberta.** Eu não queria regra de firewall liberando tráfego de entrada para o relay.

## A solução

### Túnel de saída em vez de porta aberta

A VM roda no Google Cloud com um endereço externo estático reservado. O tráfego de entrada chega por um túnel da Cloudflare: o agente `cloudflared` na VM abre conexões de saída até a borda da Cloudflare, e as requisições voltam por elas. Como a conexão nasce de dentro, não existe porta pública para o relay. Quem escaneia o IP da VM não acha nada.

Na borda, uma regra de WAF bloqueia tudo que chega no hostname do relay, a menos que venha de um Worker das nossas próprias zonas ou de uma lista curta de IPs de manutenção.

```
Worker -> borda da Cloudflare (regra de WAF) -> túnel -> cloudflared na VM
       -> nginx em 127.0.0.1 -> OpenSRS            (sai com o IP fixo)
                             -> gateway EPP local -> Registro.br (sai com o IP fixo)
```

### nginx em loopback, um token por destino

O nginx escuta só em `127.0.0.1`. São duas rotas, cada uma com seu próprio token, validado por um `map` do nginx. Vazar o token da OpenSRS não abre o Registro.br, e vice-versa.

Antes de repassar a requisição, o nginx apaga o cabeçalho do token. O segredo do relay nunca chega ao upstream nem aparece em log de terceiro. Para a OpenSRS, a conexão TLS de saída verifica o certificado e o nome do servidor, então ninguém no caminho consegue se passar pelo registrador.

### Contenção

Qualquer Host desconhecido cai num servidor padrão que responde `404`. A rota da OpenSRS aceita apenas `POST`. O corpo tem tamanho máximo e os timeouts são explícitos, curtos para conectar e mais longos para a resposta, porque um registro pode demorar. A única rota sem token é um `healthz` que responde `ok` e não faz mais nada.

A conta de serviço da VM só tem permissão para escrever log e métrica. O SSH usa o login do próprio provedor de nuvem, sem senha e sem root.

### Reconstruível do zero

Toda a configuração mora num repositório, sem segredos: nginx, units do systemd, configuração do túnel, regra de WAF e agente de observabilidade. O README traz o passo a passo para recriar a VM e marca cada afirmação como **fato** (medido na máquina) ou **suposição** (inferido). Quem mexer depois sabe em que pode confiar sem conferir.

## Um exemplo

A parte central do nginx, com nomes genéricos:

```nginx
map $http_x_proxy_token $registrar_a_ok {
    default 0;
    "token-a-64-chars..." 1;
}

server {
    listen 127.0.0.1:8443;
    server_name relay.example.com;
    client_max_body_size 256k;

    location = /registrar-a {
        limit_except POST { deny all; }
        if ($registrar_a_ok = 0) { return 403; }
        # The relay secret must never reach the registrar or its logs.
        proxy_set_header X-Proxy-Token "";
        proxy_ssl_verify on;
        proxy_ssl_server_name on;
        proxy_pass https://api.registrar-a.example:443/;
    }

    location / { return 404; }
}
```

E o que acontece com quatro requisições diferentes:

| Requisição | Onde para | Resposta |
| --- | --- | --- |
| Worker nosso, token certo, `POST` | Passa por tudo e sai com o IP fixo | Resposta da OpenSRS |
| Script qualquer na internet, mesma URL | Regra de WAF na borda | Bloqueada, nem chega na VM |
| Worker nosso, token do outro destino | `map` do nginx | `403` |
| Varredura direta no IP da VM | Não há porta aberta | Sem resposta |

## Resultado

Os Workers registram e gerenciam domínios nos dois registradores a partir de um único IP fixo, sem porta aberta na internet e sem proxy aberto. São quatro camadas independentes: WAF na borda, túnel sem porta, nginx em loopback e um token por destino. E a máquina pode sumir amanhã: o repositório diz como recriá-la.

## O que eu levo disso

Quando a plataforma não dá IP fixo, não improviso um proxy aberto. Uso túnel de saída, escuta só em loopback, um segredo por destino e remoção do segredo antes do upstream. E aprendi a valorizar a documentação que separa o que foi medido do que foi suposto: é ela que deixa outra pessoa mexer na infraestrutura sem medo.
