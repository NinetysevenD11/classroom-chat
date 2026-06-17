FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    LESSON_PERSIST_DIR=/data \
    CLASSROOM_INTEGRATED=1 \
    RENDER=true

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

COPY app.py pipeline.py state.py pdf_utils.py accounts_store.py ./
COPY services/ ./services/
COPY templates/ ./templates/
COPY check_library.py layout_audit.py ./

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["python", "app.py"]
