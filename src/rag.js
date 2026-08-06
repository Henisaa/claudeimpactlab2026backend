/**
 * RAG del baúl: recuperación léxica (FTS5/BM25, sin servicios externos de
 * embeddings) sobre dos colecciones:
 *
 *   1. Los documentos del propio paciente (lo extraído y confirmado de sus
 *      fotos: recetas, informes de alta, indicaciones).
 *   2. El corpus oficial compartido (fuentes MINSAL/DEIS del vault del
 *      proyecto y la matriz clínica con sus fuentes).
 *
 * La generación (responder en lenguaje simple citando estos chunks) vive en
 * claude.js. Este archivo no llama a ningún modelo: indexa y recupera.
 */

import { db, nuevoId } from "./db.js";
import { cifrar, descifrar } from "./seguridad.js";

const insertarChunk = db.prepare(`
  INSERT INTO rag_chunks (id, paciente_id, documento_id, tipo, fuente, url_fuente, seccion, contenido)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertarFts = db.prepare(
  "INSERT INTO rag_fts (chunk_id, contenido) VALUES (?, ?)",
);

/**
 * Trocea texto en fragmentos de ~900 caracteres respetando párrafos.
 * Suficiente para BM25; no hace falta solapamiento con fragmentos por párrafo.
 */
export function trocear(texto, maxLargo = 900) {
  const parrafos = texto
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40);

  const chunks = [];
  let actual = "";
  for (const p of parrafos) {
    if (actual && actual.length + p.length > maxLargo) {
      chunks.push(actual);
      actual = "";
    }
    actual = actual ? `${actual}\n${p}` : p;
    while (actual.length > maxLargo * 1.6) {
      chunks.push(actual.slice(0, maxLargo));
      actual = actual.slice(maxLargo);
    }
  }
  if (actual) chunks.push(actual);
  return chunks;
}

export function indexar({
  texto,
  tipo,
  fuente,
  pacienteId = null,
  documentoId = null,
  urlFuente = null,
  seccion = null,
}) {
  const ids = [];
  for (const contenido of trocear(texto)) {
    const id = nuevoId("CHK");
    const almacenado = tipo === "documento_paciente" ? cifrar(contenido) : contenido;
    insertarChunk.run(id, pacienteId, documentoId, tipo, fuente, urlFuente, seccion, almacenado);
    // FTS necesita texto legible para recuperar; el contenido clínico de la tabla
    // sigue cifrado y el fragmento se descifra solo al construir la respuesta.
    insertarFts.run(id, contenido);
    ids.push(id);
  }
  return ids;
}

/** Reindexa un documento del paciente (borra sus chunks previos). */
export function reindexarDocumento(documentoId, args) {
  const previos = db
    .prepare("SELECT id FROM rag_chunks WHERE documento_id = ?")
    .all(documentoId);
  const borrarFts = db.prepare("DELETE FROM rag_fts WHERE chunk_id = ?");
  for (const { id } of previos) borrarFts.run(id);
  db.prepare("DELETE FROM rag_chunks WHERE documento_id = ?").run(documentoId);
  return indexar({ ...args, documentoId });
}

/** Convierte una pregunta libre en consulta FTS5 tolerante (OR de prefijos). */
function consultaFts(pregunta) {
  const terminos = pregunta
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .match(/[a-zñ0-9]{3,}/gi) ?? [];
  const VACIAS = new Set([
    "que", "como", "cuando", "donde", "para", "por", "con", "sin", "los",
    "las", "una", "uno", "del", "esta", "este", "esto", "hay", "mas", "muy",
    "tengo", "puedo", "debo", "deberia", "hace", "dias", "hoy", "sobre",
  ]);
  const utiles = [...new Set(terminos.filter((t) => !VACIAS.has(t)))];
  if (utiles.length === 0) return null;
  return utiles.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * Recupera los mejores fragmentos para una pregunta: los del paciente y los
 * del corpus oficial, por separado, para que la respuesta distinga siempre
 * "sus documentos" de "las guías oficiales".
 */
export function buscar(pregunta, pacienteId, topK = 6) {
  const consulta = consultaFts(pregunta);
  if (!consulta) return { delPaciente: [], oficiales: [] };

  const filas = db
    .prepare(
      `SELECT c.id, c.paciente_id, c.tipo, c.fuente, c.url_fuente, c.seccion,
              c.contenido, bm25(rag_fts) AS puntaje
       FROM rag_fts
       JOIN rag_chunks c ON c.id = rag_fts.chunk_id
       WHERE rag_fts MATCH ?
         AND (c.paciente_id IS NULL OR c.paciente_id = ?)
       ORDER BY puntaje
       LIMIT 40`,
    )
    .all(consulta, pacienteId);

  const descifrarFila = (f) => f.tipo === "documento_paciente" ? { ...f, contenido: descifrar(f.contenido) } : f;
  return {
    delPaciente: filas.filter((f) => f.paciente_id === pacienteId).slice(0, topK).map(descifrarFila),
    oficiales: filas.filter((f) => f.paciente_id === null).slice(0, topK),
  };
}
