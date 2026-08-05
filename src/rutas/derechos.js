/**
 * Consentimientos (Decreto 31) y derechos del titular (Ley 21.719):
 * acceso, portabilidad y registro verificable de cada otorgamiento o
 * revocación. La revocación no borra datos ya registrados: genera un nuevo
 * evento con otorgado = 0 y el sistema deja de procesar desde ese momento.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
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
