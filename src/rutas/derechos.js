/**
 * Consentimientos (Decreto 31) y derechos del titular (Ley 21.719):
 * acceso, portabilidad y registro verificable de cada otorgamiento o
 * revocación. La revocación no borra datos ya registrados: genera un nuevo
 * evento con otorgado = 0 y el sistema deja de procesar desde ese momento.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente } from "../auth.js";

export const rutasDerechos = Router();

const TIPOS = ["tratamiento_datos", "compartir_cuidador", "uso_ia", "contacto_telefonico"];
const VERSION_FORMULARIO = "demo-v1";

const TEXTO_FORMULARIO = {
  tratamiento_datos:
    "Autorizo el tratamiento de mis datos de salud para el seguimiento de mi recuperación, según la Ley 21.719.",
  compartir_cuidador:
    "Autorizo a mi cuidador o cuidadora a ver mi información y registrar síntomas en mi nombre.",
  uso_ia:
    "Autorizo que la aplicación use inteligencia artificial para leer mis documentos y responder mis preguntas. La IA no diagnostica ni indica tratamientos.",
  contacto_telefonico:
    "Autorizo el contacto telefónico de seguimiento a las 24 horas del alta (modelo CPO-24).",
};

/** Estado vigente de cada tipo de consentimiento. */
rutasDerechos.get(
  "/pacientes/:pacienteId/consentimientos",
  exigirAccesoAPaciente,
  (req, res) => {
    const vigentes = {};
    for (const tipo of TIPOS) {
      const fila = db
        .prepare(
          `SELECT otorgado, fecha, medio FROM consentimientos
           WHERE paciente_id = ? AND tipo = ?
           ORDER BY fecha DESC, rowid DESC LIMIT 1`,
        )
        .get(req.params.pacienteId, tipo);
      vigentes[tipo] = {
        otorgado: fila?.otorgado === 1,
        fecha: fila?.fecha ?? null,
        texto: TEXTO_FORMULARIO[tipo],
      };
    }
    res.json({ consentimientos: vigentes, versionFormulario: VERSION_FORMULARIO });
  },
);

/** Otorga o revoca. Solo el propio paciente (matriz de permisos §4.2). */
rutasDerechos.post(
  "/pacientes/:pacienteId/consentimientos",
  exigirAccesoAPaciente,
  (req, res) => {
    if (req.usuario.tipo !== "paciente" || req.usuario.pacienteId !== req.params.pacienteId) {
      return res
        .status(403)
        .json({ error: "Solo la propia persona puede otorgar o revocar sus consentimientos." });
    }
    const { tipo, otorgado } = req.body ?? {};
    if (!TIPOS.includes(tipo) || typeof otorgado !== "boolean") {
      return res.status(400).json({ error: "Se requiere tipo válido y otorgado (boolean)." });
    }
    const hash = createHash("sha256")
      .update(`${VERSION_FORMULARIO}:${TEXTO_FORMULARIO[tipo]}`)
      .digest("hex");
    db.prepare(
      `INSERT INTO consentimientos (id, paciente_id, tipo, otorgado, medio, version_formulario, formulario_hash, ip_address)
       VALUES (?, ?, ?, ?, 'app', ?, ?, ?)`,
    ).run(nuevoId("CON"), req.params.pacienteId, tipo, otorgado ? 1 : 0, VERSION_FORMULARIO, hash, req.ip ?? null);

    if (tipo === "tratamiento_datos") {
      db.prepare("UPDATE pacientes SET consentimiento_activo = ?, actualizado_en = datetime('now') WHERE id = ?").run(otorgado ? 1 : 0, req.params.pacienteId);
    }

    if (tipo === "compartir_cuidador") {
      db.prepare(
        "UPDATE cuidadores SET consentimiento_paciente = ? WHERE paciente_id = ?",
      ).run(otorgado ? 1 : 0, req.params.pacienteId);
    }

    auditar({
      usuario: req.usuario,
      accion: "escritura",
      recurso: `consentimientos/${req.params.pacienteId}`,
      campo: tipo,
      valorNuevo: otorgado ? "otorgado" : "revocado",
      req,
    });
    res.status(201).json({ ok: true });
  },
);

rutasDerechos.get("/pacientes/:pacienteId/consentimientos/historial", exigirAccesoAPaciente, (req, res) => {
  res.json({ historial: db.prepare("SELECT * FROM consentimientos WHERE paciente_id = ? ORDER BY fecha DESC, rowid DESC").all(req.params.pacienteId) });
});

rutasDerechos.delete("/pacientes/:pacienteId/consentimientos/:tipo", exigirAccesoAPaciente, (req, res) => {
  if (req.usuario.tipo !== "paciente" || req.usuario.pacienteId !== req.params.pacienteId) return res.status(403).json({ error: "Solo el paciente puede revocar el consentimiento." });
  if (!TIPOS.includes(req.params.tipo)) return res.status(400).json({ error: "Tipo de consentimiento inválido." });
  req.body = { tipo: req.params.tipo, otorgado: false };
  const hash = createHash("sha256").update(`${VERSION_FORMULARIO}:${TEXTO_FORMULARIO[req.params.tipo]}`).digest("hex");
  db.prepare("INSERT INTO consentimientos (id, paciente_id, tipo, otorgado, medio, version_formulario, formulario_hash, ip_address) VALUES (?, ?, ?, 0, 'app', ?, ?, ?)").run(nuevoId("CON"), req.params.pacienteId, req.params.tipo, VERSION_FORMULARIO, hash, req.ip ?? null);
  if (req.params.tipo === "tratamiento_datos") db.prepare("UPDATE pacientes SET consentimiento_activo = 0, actualizado_en = datetime('now') WHERE id = ?").run(req.params.pacienteId);
  if (req.params.tipo === "compartir_cuidador") db.prepare("UPDATE cuidadores SET consentimiento_paciente = 0 WHERE paciente_id = ?").run(req.params.pacienteId);
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `consentimientos/${req.params.pacienteId}`, campo: req.params.tipo, valorNuevo: "revocado", req });
  res.json({ ok: true });
});

/** Derecho de acceso y portabilidad: todos mis datos, en JSON estructurado. */
rutasDerechos.get(
  "/pacientes/:pacienteId/mis-datos",
  exigirAccesoAPaciente,
  (req, res) => {
    const { pacienteId } = req.params;
    const de = (sql) => db.prepare(sql).all(pacienteId);
    const exportado = {
      generadoEn: new Date().toISOString(),
      base: "Ley 21.719, derecho de acceso y portabilidad",
      paciente: db.prepare("SELECT * FROM pacientes WHERE id = ?").get(pacienteId),
      eventosQuirurgicos: de("SELECT * FROM eventos_quirurgicos WHERE paciente_id = ?"),
      conciliacionFarmacologica: de("SELECT * FROM conciliacion_farmacologica WHERE paciente_id = ?"),
      seguimientos: de("SELECT * FROM seguimientos WHERE paciente_id = ?"),
      alertas: de("SELECT * FROM alertas WHERE paciente_id = ?"),
      documentos: de("SELECT * FROM documentos_clinicos WHERE paciente_id = ?"),
      camposExtraidos: de(
        `SELECT t.* FROM trazabilidad_extraccion t
         JOIN documentos_clinicos d ON d.id = t.documento_id WHERE d.paciente_id = ?`,
      ),
      consentimientos: de("SELECT * FROM consentimientos WHERE paciente_id = ?"),
      misAccesos: db
        .prepare(
          `SELECT accion, recurso, timestamp FROM auditoria_acceso
           WHERE usuario_id IN (SELECT id FROM usuarios WHERE paciente_id = ?)
           ORDER BY timestamp DESC LIMIT 200`,
        )
        .all(pacienteId),
    };
    auditar({
      usuario: req.usuario,
      accion: "exportacion",
      recurso: `mis-datos/${pacienteId}`,
      req,
    });
    res.json(exportado);
  },
);

rutasDerechos.get("/pacientes/:pacienteId/mis-datos/export", exigirAccesoAPaciente, (req, res) => {
  const formato = String(req.query.format ?? "json");
  const pacienteId = req.params.pacienteId;
  if (formato === "json") return res.json(paqueteDatos(pacienteId));
  if (formato !== "csv") return res.status(400).json({ error: "Formato soportado: json o csv." });
  const filas = db.prepare("SELECT id, paciente_id, dia_postoperatorio, fecha_registro, dolor_reportado, estado_herida, movilidad, necesidad_derivacion FROM seguimientos WHERE paciente_id = ?").all(pacienteId);
  const csv = ["id,paciente_id,dia_postoperatorio,fecha_registro,dolor_reportado,estado_herida,movilidad,necesidad_derivacion", ...filas.map((f) => Object.values(f).map(csvEscape).join(","))].join("\n");
  auditar({ usuario: req.usuario, accion: "exportacion", recurso: `mis-datos/${pacienteId}/export`, req });
  res.type("text/csv").send(csv);
});

rutasDerechos.patch("/pacientes/:pacienteId/mis-datos/:campo", exigirAccesoAPaciente, (req, res) => {
  const campos = ["nombre_ficticio", "comuna_ficticia", "region", "tipo_apoyo", "fragilidad", "riesgo_nutricional"];
  if (!campos.includes(req.params.campo)) return res.status(400).json({ error: "Campo no rectificable por esta vía." });
  const motivo = String(req.body?.motivo ?? "").trim();
  if (!motivo) return res.status(400).json({ error: "El motivo es obligatorio." });
  const id = nuevoId("REC");
  db.prepare("INSERT INTO solicitudes_rectificacion (id, paciente_id, campo, valor_solicitado, motivo) VALUES (?, ?, ?, ?, ?)").run(id, req.params.pacienteId, req.params.campo, String(req.body?.valorSolicitado ?? ""), motivo);
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `rectificaciones/${id}`, req });
  res.status(202).json({ solicitudId: id, estado: "pendiente_revision_profesional" });
});

rutasDerechos.post("/pacientes/:pacienteId/oposiciones", exigirAccesoAPaciente, (req, res) => {
  if (req.usuario.tipo !== "paciente" || req.usuario.pacienteId !== req.params.pacienteId) return res.status(403).json({ error: "Solo el paciente puede oponerse al tratamiento." });
  const finalidad = String(req.body?.finalidad ?? "").trim();
  if (!finalidad) return res.status(400).json({ error: "La finalidad es obligatoria." });
  const id = nuevoId("OPO");
  db.prepare("INSERT INTO oposiciones_tratamiento (id, paciente_id, finalidad, motivo) VALUES (?, ?, ?, ?)").run(id, req.params.pacienteId, finalidad, req.body?.motivo ?? null);
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `oposiciones/${id}`, req });
  res.status(201).json({ oposicionId: id });
});

rutasDerechos.post("/pacientes/:pacienteId/supresion", exigirAccesoAPaciente, supresion);
rutasDerechos.delete("/pacientes/:pacienteId/cuenta", exigirAccesoAPaciente, supresion);

function supresion(req, res) {
  const { pacienteId } = req.params;
  if (req.usuario.tipo !== "paciente" || req.usuario.pacienteId !== pacienteId) return res.status(403).json({ error: "Solo el paciente puede solicitar supresión." });
  const existente = db.prepare("SELECT id FROM solicitudes_arco WHERE paciente_id = ? AND tipo = 'supresion' AND estado = 'procesada'").get(pacienteId);
  if (existente) return res.json({ solicitudId: existente.id, estado: "procesada" });
  const solicitudId = nuevoId("SUP");
  const anonimo = `ANON-${pacienteId}`;
  const procesar = db.transaction(() => {
    db.prepare("INSERT INTO solicitudes_arco (id, paciente_id, tipo, estado, detalle, procesada_en, procesada_por) VALUES (?, ?, 'supresion', 'procesada', ?, datetime('now'), ?)").run(solicitudId, pacienteId, "Datos anonimizados; auditoría conservada por obligación legal.", req.usuario.id);
    db.prepare("UPDATE pacientes SET nombre_ficticio = ?, comuna_ficticia = 'ANONIMIZADA', region = 'ANONIMIZADA', tipo_apoyo = 'autonomo', fragilidad = 0, riesgo_nutricional = 'normal', consentimiento_activo = 0, actualizado_en = datetime('now') WHERE id = ?").run(anonimo, pacienteId);
    db.prepare("UPDATE seguimientos SET fuente_dato = 'ANONIMIZADO', orientacion_entregada = 0, recomendacion_urgencia = 0 WHERE paciente_id = ?").run(pacienteId);
    db.prepare("UPDATE alertas SET descripcion = 'ALERTA ANONIMIZADA', accion_tomada = NULL WHERE paciente_id = ?").run(pacienteId);
    db.prepare("UPDATE consentimientos SET formulario_hash = NULL, ip_address = NULL WHERE paciente_id = ?").run(pacienteId);
    const documentos = db.prepare("SELECT id, ruta_local FROM documentos_clinicos WHERE paciente_id = ?").all(pacienteId);
    for (const doc of documentos) {
      if (doc.ruta_local) try { unlinkSync(doc.ruta_local); } catch { /* archivo ya eliminado */ }
      db.prepare("UPDATE documentos_clinicos SET nombre_original = 'DOCUMENTO_ANONIMIZADO', ruta_local = NULL, estado_proceso = 'error' WHERE id = ?").run(doc.id);
      db.prepare("UPDATE trazabilidad_extraccion SET valor_estructurado = NULL, texto_original = 'ANONIMIZADO', conflicto_con_otro_doc = NULL WHERE documento_id = ?").run(doc.id);
    }
    db.prepare("DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE paciente_id = ?)").run(pacienteId);
    db.prepare("DELETE FROM rag_chunks WHERE paciente_id = ?").run(pacienteId);
  });
  procesar();
  auditar({ usuario: req.usuario, accion: "eliminacion", recurso: `mi-cuenta/${pacienteId}`, req });
  res.status(202).json({ solicitudId, estado: "procesada", auditoriaConservada: true });
}

function paqueteDatos(pacienteId) {
  const de = (sql) => db.prepare(sql).all(pacienteId);
  return {
    generadoEn: new Date().toISOString(), base: "Ley 21.719, acceso y portabilidad",
    paciente: db.prepare("SELECT * FROM pacientes WHERE id = ?").get(pacienteId),
    eventosQuirurgicos: de("SELECT * FROM eventos_quirurgicos WHERE paciente_id = ?"),
    indicaciones: db.prepare("SELECT i.* FROM indicaciones_alta i JOIN eventos_quirurgicos e ON e.id = i.evento_quirurgico_id WHERE e.paciente_id = ?").all(pacienteId),
    conciliacionFarmacologica: de("SELECT * FROM conciliacion_farmacologica WHERE paciente_id = ?"),
    seguimientos: de("SELECT * FROM seguimientos WHERE paciente_id = ?"), alertas: de("SELECT * FROM alertas WHERE paciente_id = ?"),
    documentos: de("SELECT * FROM documentos_clinicos WHERE paciente_id = ?"), consentimientos: de("SELECT * FROM consentimientos WHERE paciente_id = ?"),
    solicitudesArco: de("SELECT * FROM solicitudes_arco WHERE paciente_id = ?"), oposiciones: de("SELECT * FROM oposiciones_tratamiento WHERE paciente_id = ?"),
  };
}

function csvEscape(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
