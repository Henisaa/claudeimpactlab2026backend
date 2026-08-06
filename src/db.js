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

import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// better-sqlite3 trae un binario nativo que no siempre coincide con el Node
// de cada máquina del equipo (p. ej. Node 24 en Windows). Si no carga, se usa
// node:sqlite integrado con un adaptador que expone la misma API que usa el
// resto del backend (prepare/exec/pragma/transaction/close).
const require = createRequire(import.meta.url);

function abrirBase(ruta) {
  try {
    const Database = require("better-sqlite3");
    return new Database(ruta);
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    const base = new DatabaseSync(ruta);
    return {
      prepare: (sql) => base.prepare(sql),
      exec: (sql) => base.exec(sql),
      pragma: (orden) => base.exec(`PRAGMA ${orden}`),
      close: () => base.close(),
      transaction: (fn) => (...args) => {
        base.exec("BEGIN");
        try {
          const resultado = fn(...args);
          base.exec("COMMIT");
          return resultado;
        } catch (error) {
          base.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
}

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUTA_DATA = path.join(RAIZ, "data");
export const RUTA_UPLOADS = path.join(RAIZ, "uploads");
export const RUTA_MATRIZ = path.join(RUTA_DATA, "matriz-etc.json");
mkdirSync(RUTA_UPLOADS, { recursive: true });

const rutaDb = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(RUTA_DATA, "prototipo.db");
mkdirSync(path.dirname(rutaDb), { recursive: true });
export const db = abrirBase(rutaDb);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = path.join(RAIZ, "src", "schema.sql");
db.exec(readFileSync(schemaPath, "utf8"));

// --- Migraciones idempotentes ----------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS rag_chunks (
  id             TEXT PRIMARY KEY,
  paciente_id    TEXT REFERENCES pacientes(id),  -- NULL = corpus compartido
  documento_id   TEXT REFERENCES documentos_clinicos(id),
  tipo           TEXT NOT NULL CHECK (tipo IN ('documento_paciente','guia_oficial','nota_proyecto','matriz_clinica')),
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

// La primera versión del prototipo no distinguía las notas curatoriales de las
// fuentes oficiales. Reconstruir solo esta tabla permite actualizar una base
// existente sin perder chunks ni confundir la procedencia en el RAG.
const sqlRagChunks = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rag_chunks'")
  .get()?.sql ?? "";
if (!sqlRagChunks.includes("nota_proyecto")) {
  db.exec("DROP INDEX IF EXISTS idx_rag_chunks_paciente");
  db.transaction(() => {
    db.exec("ALTER TABLE rag_chunks RENAME TO rag_chunks_legacy");
    db.exec(`
      CREATE TABLE rag_chunks (
        id             TEXT PRIMARY KEY,
        paciente_id    TEXT REFERENCES pacientes(id),
        documento_id   TEXT REFERENCES documentos_clinicos(id),
        tipo           TEXT NOT NULL CHECK (tipo IN ('documento_paciente','guia_oficial','nota_proyecto','matriz_clinica')),
        fuente         TEXT NOT NULL,
        url_fuente     TEXT,
        seccion        TEXT,
        contenido      TEXT NOT NULL,
        fecha_indexado TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO rag_chunks (id, paciente_id, documento_id, tipo, fuente, url_fuente, seccion, contenido, fecha_indexado)
      SELECT id, paciente_id, documento_id, tipo, fuente, url_fuente, seccion, contenido, fecha_indexado
      FROM rag_chunks_legacy;
      DROP TABLE rag_chunks_legacy;
      CREATE INDEX idx_rag_chunks_paciente ON rag_chunks(paciente_id);
    `);
  })();
}

// Teléfono de la persona de apoyo, para el canal WhatsApp. Cifrado con la
// misma capa que el resto de los campos sensibles; nunca viaja en el mensaje.
const columnasCuidadores = db
  .prepare("SELECT name FROM pragma_table_info('cuidadores')")
  .all()
  .map((c) => c.name);
if (!columnasCuidadores.includes("telefono_contacto")) {
  db.exec("ALTER TABLE cuidadores ADD COLUMN telefono_contacto TEXT");
}

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
