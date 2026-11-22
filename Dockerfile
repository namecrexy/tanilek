# syntax=docker/dockerfile:1
# =============================================================================
# TaniLek – wieloetapowy obraz oparty na oficjalnym oven/bun (Debian slim, glibc)
#   1. deps    – instalacja zależności produkcyjnych (w tym natywnego DuckDB)
#   2. data    – budowa data/leki.parquet (API dane.gov.pl lub próbka demo)
#   3. runtime – minimalny obraz uruchomieniowy jako użytkownik bez uprawnień root
# =============================================================================

ARG BUN_VERSION=1

# --- 1. Zależności ------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- 2. Dane ------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS data
WORKDIR /app
# FETCH_MODE=api  – próba pobrania wykazu (w razie braku sieci/błędu: automatycznie próbka demo)
# FETCH_MODE=demo – tylko próbka demo, bez dostępu do sieci (szybko i deterministycznie)
ARG FETCH_MODE=api
ARG SOURCE_URL=
ARG DANE_GOV_DATASET_ID=
ARG DANE_GOV_API_BASE=https://api.dane.gov.pl/1.4
ENV NODE_ENV=production \
    DATA_FILE_PATH=/app/data/leki.parquet \
    FALLBACK_CSV_PATH=/app/tests/fixtures/sample_leki.csv
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests/fixtures ./tests/fixtures
RUN mkdir -p data \
    && if [ "$FETCH_MODE" = "demo" ]; then bun scripts/fetch_data.ts --demo; else bun scripts/fetch_data.ts; fi \
    && ls -la data

# --- 3. Obraz uruchomieniowy ---------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE_PATH=/app/data/leki.parquet \
    FALLBACK_CSV_PATH=/app/tests/fixtures/sample_leki.csv
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun tests/fixtures ./tests/fixtures
COPY --from=data --chown=bun:bun /app/data ./data

USER bun
EXPOSE 3000

# Obraz slim nie zawiera curl – healthcheck wykonuje sam Bun.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "src/server.ts"]
