#!/bin/bash
set -euo pipefail

echo '=== Infobip Extension VPS ==='
read -rp 'Cole o WEBHOOK_URL do seu N8N: ' WEBHOOK_URL
read -rsp 'Crie um API_TOKEN forte (não use espaços): ' API_TOKEN
echo

if [[ -z "$WEBHOOK_URL" || -z "$API_TOKEN" ]]; then
  echo 'WEBHOOK_URL e API_TOKEN são obrigatórios.'
  exit 1
fi

cp .env.example .env
sed -i "s|^WEBHOOK_URL=.*|WEBHOOK_URL=$WEBHOOK_URL|" .env
sed -i "s|^API_TOKEN=.*|API_TOKEN=$API_TOKEN|" .env

sed -i "s|CHANGE_ME_API_TOKEN|$API_TOKEN|g" extension/scripts/background.js

echo 'Subindo containers...'
docker compose up -d --build

echo

echo 'Containers:'
docker compose ps

echo
echo 'Abra o Chrome da VPS com um túnel SSH:'
echo '  ssh -L 6080:127.0.0.1:6080 usuario@IP_DA_VPS'
echo 'Depois acesse: http://127.0.0.1:6080'
echo
