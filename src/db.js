/**
 * Base de datos SQLite. Se usa better-sqlite3 para que el backend sea
 * reproducible desde Node >= 20. El esquema base se crea desde schema.sql y
 * las migraciones pequeñas de compatibilidad se aplican al arrancar.
 *
 * Aquí solo se agregan las piezas nuevas:
 *  - rag_chunks + rag_fts: el índice de recuperación del "baúl" (FTS5/BM25).
 *  - columna borrador en trazabilidad_extraccion: nada entra confirmado
 *    al baúl sin que una persona lo haya revisado.
 */

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUTA_DATA = path.join(RAIZ, "data");
export const RUTA_UPLOADS = path.join(RAIZ, "uploads");
export const RUTA_MATRIZ = path.join(RUTA_DATA, "matriz-etc.json");
mkdirSync(RUTA_UPLOADS, { recursive: true });

const rutaDb = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(RUTA_DATA, "prototipo.db");
mkdirSync(path.dirname(rutaDb), { recursive: true });
export const db = new Database(rutaDb);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = path.join(RAIZ, "src", "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

// --- Migraciones idempotentes ----------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS rag_chunks (
  id             TEXT PRIMARY KEY,
  paciente_id    TEXT REFERENCES pacientes(id),  -- NULL = corpus oficial compartido
  documento_id   TEXT REFERENCES documentos_clinicos(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('documento_paciente','guia_oficial','matriz_clinica')),
  fuente         TEXT NOT NULL,                  -- nombre legible del documento de origen
  url_fuente     TEXT,
  seccion        TEXT,
  contenido      TEXT NOT NULL,
  fecha_indexado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_paciente ON rag_chunks(paciente_id);
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
  chunk_id UNINDEXED,
  contenido,
  tokenize = "unicode61 remove_diacritics 2"
);
`);

const columnasTraz = db
  .prepare("SELECT name FROM pragma_table_info('trazabilidad_extraccion')")
  .all()
  .map((c) => c.name);
if (!columnasTraz.includes("confianza_texto")) {
  db.exec(
    "ALTER TABLE trazabilidad_extraccion ADD COLUMN confianza_texto TEXT CHECK (confianza_texto IN ('alta','media','baja'))",
  );
}
if (!columnasTraz.includes("confirmado")) {
  // Borrador hasta que una persona lo confirma contra el papel. Solo lo
  // confirmado se indexa en el RAG del baúl.
  db.exec(
    "ALTER TABLE trazabilidad_extraccion ADD COLUMN confirmado INTEGER NOT NULL DEFAULT 0",
  );
  db.exec(
    "ALTER TABLE trazabilidad_extraccion ADD COLUMN confirmado_por TEXT",
  );
}

// --- Utilidades -------------------------------------------------------------

/** Id legible con prefijo, p.ej. DOC-3F9A21C4. */
export function nuevoId(prefijo) {
  return `${prefijo}-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function ahora() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
