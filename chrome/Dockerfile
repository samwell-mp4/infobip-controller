FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV TZ=America/Sao_Paulo

RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    ca-certificates \
    curl \
    wget \
    unzip \
    procps \
    tzdata \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p \
    /opt/extension \
    /data/chrome \
    /tmp/chrome-profile

COPY extension/ /opt/extension/
COPY start.sh /start.sh

RUN chmod +x /start.sh

EXPOSE 6080

CMD ["/start.sh"]