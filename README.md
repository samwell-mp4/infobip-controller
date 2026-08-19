# Infobip Broadcast Scraper — VPS

Esta versão mantém sua extensão Chrome e adiciona:

- Chrome/Chromium persistente na VPS;
- Xvfb + Fluxbox + x11vnc para manter uma sessão gráfica;
- noVNC para acessar visualmente o Chrome;
- controlador Node.js;
- comando remoto `POST /api/start`;
- polling da extensão para receber comandos;
- envio de cada screenshot para o N8N;
- envio do CSV final para o N8N;
- status da execução para o controlador;
- reinício automático via Docker.

## 1. Requisitos

VPS Linux com Docker e Docker Compose. Na Hostinger, use um VPS com Docker habilitado/instalável.

## 2. Instalação

Copie esta pasta para a VPS, entre nela e execute:

```bash
chmod +x install.sh
./install.sh
```

O instalador pergunta:

- URL do webhook do N8N;
- API token interno.

## 3. Primeiro acesso ao Chrome

Por segurança, a porta noVNC fica disponível somente em `127.0.0.1`.

No seu computador:

```bash
ssh -L 6080:127.0.0.1:6080 root@IP_DA_VPS
```

Depois abra:

```text
http://127.0.0.1:6080
```

Faça login na Infobip no Chrome da VPS. Não apague o volume `chrome_profile`, pois ele guarda a sessão.

## 4. Iniciar pelo N8N

Exemplo:

```bash
curl -X POST http://IP_DA_VPS:3000/api/start \
  -H 'Content-Type: application/json' \
  -H 'x-api-token: SEU_TOKEN' \
  -d '{"dateFrom":1755552000000,"dateTo":1755638400000,"jobId":"relatorio-001"}'
```

Para usar o endpoint externamente, publique a porta 3000 atrás de HTTPS/reverse proxy. Não exponha a porta 3000 sem autenticação.

## 5. Status

```bash
curl http://IP_DA_VPS:3000/health
```

## 6. Arquitetura

```text
N8N -> POST /api/start
          |
          v
    controller:3000
          |
          v
    extensão Chrome
          |
          v
       Infobip
          |
      +---+---+
      |       |
     PNG     CSV
      |       |
      +---+---+
          |
          v
       N8N Webhook
```

## 7. Importante

A extensão envia cada campanha como `multipart/form-data` com:

- `type=campaign`
- `runId`
- `campaign`
- `data` (JSON)
- `image` (PNG)

No final envia:

- `type=final`
- `runId`
- `dateFrom`
- `dateTo`
- `count`
- `data` (JSON com todos os registros)
- `excel` (CSV, preservando o formato que sua extensão já gerava)

Se o seu N8N precisa de `.xlsx` de verdade, faça a conversão no próprio N8N depois do webhook. A extensão original gerava CSV, não XLSX.

## 8. Logs

```bash
docker compose logs -f chrome
docker compose logs -f controller
docker compose logs -f novnc
```

## 9. Reiniciar

```bash
docker compose restart
```

## 10. Atualizar a extensão

Substitua os arquivos dentro de `extension/` e execute:

```bash
docker compose restart chrome
```
