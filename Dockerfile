# 교실도구(Node) + 수업 자료 생성기(Python/Playwright) 통합 이미지
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    CLASSROOM_INTEGRATED=1 \
    LESSON_PORT=18080 \
    LESSON_ROOT_PATH=/lesson-svc \
    PYTHON=python3 \
    RENDER=true \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lesson-app/requirements.txt lesson-app/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r lesson-app/requirements.txt \
    && python3 -m playwright install --with-deps chromium \
    && python3 -c "import nicegui; print('nicegui ok')"

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
