---
title: Registrars required a fixed IP and Workers don't have one
summary: "Domain registrars only accept calls from a registered IP, and the API runs on Workers, which change IP on every request. I built an exit point with a fixed IP, with no open port on the internet and without exposing the reseller credential."
project: great-softwares
order: 19
tags: [Cloudflare Tunnel, nginx, Google Cloud, Networking, Security]
---

The Great Domains API's first test call to OpenSRS came back refused. The code was right, and so was the credential. The problem was the origin: OpenSRS only accepts requests coming from an IP the reseller registered beforehand, in an allowlist. Registro.br (the .br registry) does the same. And the entire API runs on Cloudflare Workers, which reach the internet through addresses that change on every call.

## The problem

Great Domains registers international domains through OpenSRS and `.br` domains through Registro.br. Both require a fixed source IP. Workers don't offer that: each request can leave from a different data center, with a different IP.

I needed an exit point with a stable address, through which all calls to the two registrars would pass.

## Why it wasn't trivial

The obvious way is to spin up a VM with a fixed IP and a proxy. The obvious way is also dangerous. A proxy exposed on the internet, with the reseller credential configured, is a "register, renew or delete domains" button for whoever finds the URL.

There were three more constraints:

- **Two destinations with different protocols.** OpenSRS speaks HTTPS. Registro.br speaks EPP (the session protocol domain registries use), through a gateway that runs on the VM itself.
- **A small, disposable machine.** It's a minimal VM. If it disappears, someone has to be able to recreate it from scratch without relying on anyone's memory.
- **No open ports.** I didn't want a firewall rule allowing inbound traffic to the relay.

## The solution

### Outbound tunnel instead of an open port

The VM runs on Google Cloud with a reserved static external address. Inbound traffic arrives through a Cloudflare tunnel: the `cloudflared` agent on the VM opens outbound connections to Cloudflare's edge, and requests come back through them. Since the connection starts from the inside, there's no public port for the relay. Anyone scanning the VM's IP finds nothing.

At the edge, a WAF rule blocks everything that reaches the relay's hostname, unless it comes from a Worker in our own zones or from a short list of maintenance IPs.

```
Worker -> Cloudflare edge (WAF rule) -> tunnel -> cloudflared on the VM
       -> nginx on 127.0.0.1 -> OpenSRS            (leaves with the fixed IP)
                             -> local EPP gateway -> Registro.br (leaves with the fixed IP)
```

### nginx on loopback, one token per destination

nginx listens only on `127.0.0.1`. There are two routes, each with its own token, validated by an nginx `map`. Leaking the OpenSRS token doesn't open Registro.br, and vice versa.

Before forwarding the request, nginx deletes the token header. The relay's secret never reaches the upstream or shows up in a third party's logs. For OpenSRS, the outbound TLS connection verifies the certificate and the server name, so nobody on the path can impersonate the registrar.

### Containment

Any unknown Host falls into a default server that responds `404`. The OpenSRS route accepts only `POST`. The body has a maximum size and the timeouts are explicit, short for connecting and longer for the response, because a registration can take a while. The only route without a token is a `healthz` that responds `ok` and does nothing else.

The VM's service account only has permission to write logs and metrics. SSH uses the cloud provider's own login, with no password and no root.

### Rebuildable from scratch

All the configuration lives in a repository, with no secrets: nginx, systemd units, tunnel configuration, WAF rule and observability agent. The README has the step-by-step to recreate the VM and marks each claim as **fact** (measured on the machine) or **assumption** (inferred). Whoever touches it later knows what they can trust without checking.

## An example

The core of the nginx config, with generic names:

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

And what happens with four different requests:

| Request | Where it stops | Response |
| --- | --- | --- |
| Our Worker, right token, `POST` | Goes through everything and leaves with the fixed IP | OpenSRS's response |
| Any script on the internet, same URL | WAF rule at the edge | Blocked, never reaches the VM |
| Our Worker, token for the other destination | nginx `map` | `403` |
| Direct scan of the VM's IP | There's no open port | No response |

## Result

The Workers register and manage domains at both registrars from a single fixed IP, with no open port on the internet and no open proxy. There are four independent layers: WAF at the edge, a tunnel with no port, nginx on loopback and a token per destination. And the machine could disappear tomorrow: the repository says how to recreate it.

## What I take from it

When the platform doesn't give a fixed IP, I don't improvise an open proxy. I use an outbound tunnel, listen only on loopback, one secret per destination and removal of the secret before the upstream. And I learned to value documentation that separates what was measured from what was assumed: it's what lets another person touch the infrastructure without fear.
