# Backend ETC (Express + SQLite + Claude) — imagen para docker compose
# Etapa de construcción: compila better-sqlite3 (binario nativo).
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY data ./data

# Etapa de ejecución: solo lo necesario para correr la API.
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=development \
    DEMO_MODE=true \
    CLAUDE_MOCK=true \
    JWT_SECRET=contigo-demo-secret \
    ENCRYPTION_KEY=contigo-demo-encryption-key \
    NOTIFICACIONES_PROVEEDOR=simulado \
    APP_URL=http://localhost:3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/data ./data
COPY package.json ./

RUN mkdir -p uploads

EXPOSE 4000

# Seed (demo determinística) y arranque de la API.
CMD ["sh", "-c", "node src/seed.js && node src/server.js"]
