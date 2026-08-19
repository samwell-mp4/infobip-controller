#!/bin/bash

set -e

echo "======================================"
echo " INFObip Chrome VPS"
echo "======================================"

export DISPLAY=:99

echo "[1/5] Iniciando Xvfb..."

Xvfb :99 \
    -screen 0 1920x1080x24 \
    -ac \
    +extension GLX \
    +render \
    -noreset \
    > /tmp/xvfb.log 2>&1 &

sleep 2

echo "[2/5] Iniciando Fluxbox..."

fluxbox \
    > /tmp/fluxbox.log 2>&1 &

sleep 2

echo "[3/5] Iniciando x11vnc..."

x11vnc \
    -display :99 \
    -forever \
    -shared \
    -nopw \
    -rfbport 5900 \
    -listen 0.0.0.0 \
    > /tmp/x11vnc.log 2>&1 &

sleep 2

echo "[4/5] Iniciando noVNC..."

websockify \
    --web=/usr/share/novnc/ \
    6080 \
    localhost:5900 \
    > /tmp/novnc.log 2>&1 &

sleep 3

echo "[5/5] Iniciando Chromium..."

mkdir -p /data/chrome

chromium \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-infobars \
    --start-maximized \
    --window-size=1920,1080 \
    --user-data-dir=/data/chrome \
    --load-extension=/opt/extension \
    --no-first-run \
    --no-default-browser-check \
    "https://portal-ny2.infobip.com/" \
    > /tmp/chromium.log 2>&1 &

echo ""
echo "======================================"
echo " Chrome iniciado"
echo " noVNC: http://0.0.0.0:6080"
echo "======================================"

wait