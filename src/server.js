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
import { login, autenticar } from "./auth.js";
import { auditarLecturas } from "./auditoria.js";
import { rutasBaul } from "./rutas/baul.js";
import { rutasSeguimiento } from "./rutas/seguimiento.js";
import { rutasDerechos } from "./rutas/derechos.js";

const app = express();
app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));
app.use(express.json({ limit: "1mb" }));

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

app.use("/api/v1", autenticar, auditarLecturas, rutasBaul, rutasSeguimiento, rutasDerechos);

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

const PUERTO = process.env.PORT ?? 4000;
app.listen(PUERTO, () => {
  console.log(`Backend ETC escuchando en http://localhost:${PUERTO}`);
});
