/**
 * Backend de continuidad postoperatoria ETC — Claude Impact Lab 2026, Línea 03.
 *
 * API REST sobre data/prototipo.db. Ver BACKEND_IDEALIZADO.md en el vault del
 * proyecto para la arquitectura de destino; esto implementa su núcleo:
 * autenticación por roles, consentimiento, auditoría, baúl persistente,
 * check-ins con motor determinístico, alertas y el RAG del baúl.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { login, autenticar } from "./auth.js";
import { auditarLecturas } from "./auditoria.js";
import { rutasBaul } from "./rutas/baul.js";
import { rutasSeguimiento } from "./rutas/seguimiento.js";
import { rutasDerechos } from "./rutas/derechos.js";
import { rutasAdmin } from "./rutas/admin.js";
import { rutasCrud } from "./rutas/crud.js";
import { rutasCpo24 } from "./rutas/cpo24.js";
import { rutasMedicacion } from "./rutas/medicacion.js";
import { arrancarWorkerMedicacion } from "./workers/medicacion.js";

export const app = express();
const intentos = new Map();
const origenesPermitidos = new Set(
  (process.env.CORS_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origen) => origen.trim())
    .filter(Boolean),
);
app.use(
  cors({
    origin: (origen, callback) => {
      // Las solicitudes sin Origin (curl, health checks) no necesitan CORS.
      callback(null, !origen || origenesPermitidos.has(origen));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const clave = `${req.ip}:${req.path}`;
  const ahora = Date.now();
  const previo = intentos.get(clave) ?? { inicio: ahora, cantidad: 0 };
  if (ahora - previo.inicio > 60_000) previo.inicio = ahora, previo.cantidad = 0;
  previo.cantidad += 1;
  intentos.set(clave, previo);
  if (previo.cantidad > 120) return res.status(429).json({ error: "Demasiadas solicitudes." });
  next();
});

app.get("/api/v1/salud", (_req, res) => res.json({ ok: true }));

app.post("/api/v1/auth/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "Faltan credenciales." });
  }
  const sesion = login(username, password, req);
  if (!sesion) return res.status(401).json({ error: "Credenciales inválidas." });
  res.json(sesion);
});

app.use("/api/v1", autenticar, auditarLecturas, rutasBaul, rutasSeguimiento, rutasDerechos, rutasCrud, rutasCpo24, rutasMedicacion, rutasAdmin);

// Manejador de errores: mensajes claros, sin filtrar detalles internos.
app.use((err, _req, res, _next) => {
  const status = err.status ?? (err.name === "MulterError" ? 400 : 500);
  const mensaje =
    status === 500 && !err.expose
      ? "Error interno del servidor."
      : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ error: mensaje });
});

export function iniciarServidor() {
  const PUERTO = process.env.PORT ?? 4000;
  const cert = process.env.TLS_CERT_PATH;
  const key = process.env.TLS_KEY_PATH;
  if (cert && key) {
    return https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, app).listen(PUERTO, "0.0.0.0", () => {
      console.log(`Backend ETC escuchando en https://localhost:${PUERTO}`);
    });
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_HTTP !== "true") {
    throw new Error("TLS_CERT_PATH y TLS_KEY_PATH son obligatorias en producción.");
  }
  return http.createServer(app).listen(PUERTO, "0.0.0.0", () => {
    console.warn(`Backend ETC escuchando en http://localhost:${PUERTO} (solo desarrollo)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  iniciarServidor();
  // En el prototipo el worker vive dentro del mismo proceso y solo en modo
  // demo: materializa tomas, enciende recordatorios y cierra ventanas. En
  // producción sería un proceso separado (ver plan del prototipo).
  if (process.env.DEMO_MODE === "true") arrancarWorkerMedicacion();
}
