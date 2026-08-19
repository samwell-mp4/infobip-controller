#!/bin/bash
set -e
export DISPLAY=:99
export SCREEN_WIDTH=${SCREEN_WIDTH:-1920}
export SCREEN_HEIGHT=${SCREEN_HEIGHT:-1080}
export SCREEN_DEPTH=${SCREEN_DEPTH:-24}

Xvfb :99 -screen 0 ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
sleep 2
fluxbox >/tmp/fluxbox.log 2>&1 &
sleep 2
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &
sleep 2

# Extension must be loaded unpacked. A persistent Chrome profile keeps the Infobip login.
exec google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT} \
  --start-maximized \
  --load-extension=/opt/extension \
  --user-data-dir=/home/pptruser/.config/google-chrome \
  --no-first-run \
  --no-default-browser-check \
  https://portal-ny2.infobip.com/broadcast
