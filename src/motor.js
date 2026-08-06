/**
 * Motor de reglas — port 1:1 de src/lib/motor.ts del frontend.
 *
 * Invariante del proyecto: el nivel de alerta lo decide este archivo, a partir
 * de la matriz clínica (data/matriz-etc.json, exportada desde el frontend con
 * `npm run matriz`). Claude no participa en la decisión.
 *
 * Una regla solo se evalúa si ella y su señal están `vigente` y con `fuente`.
 * Lo que no cumple eso se devuelve en `reglasBloqueadas`, visible, no ignorado.
 */

import { readFileSync } from "node:fs";
import { db, RUTA_MATRIZ, nuevoId } from "./db.js";

let matrizCache = null;

export function matriz() {
  if (!matrizCache) {
    const persistida = db
      .prepare("SELECT contenido FROM matriz_versiones WHERE activa = 1 ORDER BY creada_en DESC LIMIT 1")
      .get();
    matrizCache = persistida ? JSON.parse(persistida.contenido) : JSON.parse(readFileSync(RUTA_MATRIZ, "utf8"));
  }
  return matrizCache;
}

export function invalidarCacheMatriz() {
  matrizCache = null;
}

/** Días transcurridos desde el alta. D+0 es el día del alta. */
export function diaRelativo(fechaAlta, hoy = new Date()) {
  const alta = new Date(`${fechaAlta}T00:00:00`);
  const dia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.floor((dia.getTime() - alta.getTime()) / 86_400_000);
}

const dentroDeVentana = (dia, [desde, hasta]) => dia >= desde && dia <= hasta;

export function preguntasDelDia(m, dia) {
  return m.preguntas.filter(
    (p) => !p.ventanaDias || dentroDeVentana(dia, p.ventanaDias),
  );
}

const PRIORIDAD = { verde: 0, amarillo: 1, rojo: 2 };

export function evaluar(m, respuestas, dia) {
  const alertas = [];
  const reglasBloqueadas = [];

  for (const regla of m.reglas) {
    const senal = m.senalesAlarma.find((s) => s.id === regla.senalAlarmaId);

    if (!senal) {
      reglasBloqueadas.push({
        reglaId: regla.id,
        motivo: `La señal de alarma "${regla.senalAlarmaId}" no existe en la matriz.`,
      });
      continue;
    }
    if (regla.estado !== "vigente" || !regla.fuente) {
      reglasBloqueadas.push({
        reglaId: regla.id,
        motivo: "La regla no tiene fuente clínica verificada.",
      });
      continue;
    }
    if (senal.estado !== "vigente" || !senal.fuente) {
      reglasBloqueadas.push({
        reglaId: regla.id,
        motivo: `La señal "${senal.id}" no tiene fuente clínica verificada.`,
      });
      continue;
    }

    const respuesta = respuestas[regla.preguntaId];
    if (respuesta === undefined) continue;
    if (!regla.cuandoRespuestaEs.includes(respuesta)) continue;

    const pregunta = m.preguntas.find((p) => p.id === regla.preguntaId);
    alertas.push({
      reglaId: regla.id,
      senal,
      preguntaTexto: pregunta?.texto ?? regla.preguntaId,
      respuestaDada:
        pregunta?.opciones.find((o) => o.valor === respuesta)?.etiqueta ??
        respuesta,
    });
  }

  const color = alertas.reduce(
    (peor, a) => (PRIORIDAD[a.senal.color] > PRIORIDAD[peor] ? a.senal.color : peor),
    "verde",
  );

  const escalamiento =
    color === "verde"
      ? null
      : (m.escalamiento.find((e) => e.color === color) ?? null);

  return {
    diaRelativo: dia,
    color,
    alertas,
    normalizaciones: normalizacionesDelDia(m, dia),
    hitosProximos: hitosProximos(m, dia),
    reglasBloqueadas,
    escalamiento,
  };
}

export function normalizacionesDelDia(m, dia) {
  return m.sintomasEsperados.filter(
    (s) => s.estado === "vigente" && s.fuente && dentroDeVentana(dia, s.ventanaDias),
  );
}

export function hitosProximos(m, dia, horizonte = 7) {
  return m.hitos
    .filter((h) => h.diaRelativo !== null)
    .filter((h) => h.diaRelativo >= dia && h.diaRelativo <= dia + horizonte)
    .sort((a, b) => a.diaRelativo - b.diaRelativo);
}

export function huecosDeLaMatriz(m) {
  const huecos = [];
  if (!m.validadoPor) {
    huecos.push("La matriz completa está pendiente de validación profesional.");
  }
  for (const h of m.hitos) {
    if (h.estado !== "vigente" || h.diaRelativo === null || !h.fuente) {
      huecos.push(`Hito sin fuente o sin día definido: ${h.titulo}`);
    }
  }
  for (const s of m.senalesAlarma) {
    if (s.estado !== "vigente" || !s.fuente) {
      huecos.push(`Señal de alarma sin fuente verificada: ${s.descripcion}`);
    }
  }
  for (const e of m.escalamiento) {
    if (e.estado !== "vigente" || !e.responsable) {
      huecos.push(`Escalamiento ${e.color} sin responsable definido.`);
    }
  }
  return huecos;
}

/** Conserva un catálogo auditable de la matriz ejecutable, sin activar reglas
 * que siguen pendientes de validación profesional. */
const NIVEL = { rojo: "roja", amarillo: "amarilla", verde: "verde" };

export function persistirMatriz(m) {
  const filas = [];
  for (const h of m.hitos) filas.push({ id: `HIT-${h.id}`, categoria: "hito", contenido: h, nivel: "ninguno" });
  for (const s of m.senalesAlarma) filas.push({ id: `SIG-${s.id}`, categoria: "signo_alarma", contenido: s, nivel: NIVEL[s.color] ?? "ninguno" });
  for (const s of m.sintomasEsperados) filas.push({ id: `SINT-${s.id}`, categoria: "recomendacion", contenido: s, nivel: "ninguno" });
  for (const r of m.reglas) filas.push({ id: `REG-${r.id}`, categoria: "control", contenido: r, nivel: "ninguno" });
  const insert = db.prepare(`INSERT OR REPLACE INTO matriz_clinica
    (id, procedimiento, categoria, contenido, nivel_alerta, dia_objetivo, fuente, url_fuente, fecha_fuente, version, estado_validacion)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const transaccion = db.transaction(() => {
    db.prepare("UPDATE matriz_versiones SET activa = 0 WHERE activa = 1").run();
    db.prepare(`INSERT OR REPLACE INTO matriz_versiones
      (id, version, contenido, fuente, fecha_fuente, estado_validacion, activa)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(
      `MAT-${m.id}`,
      m.id,
      JSON.stringify(m),
      "Matriz clínica ETC — fuente de diseño pendiente de validación profesional",
      m.fechaValidacion ?? null,
      m.validadoPor ? "validada" : "pendiente_validacion",
    );
    for (const fila of filas) {
      const fuente = fila.contenido.fuente;
      insert.run(fila.id, m.cirugia, fila.categoria, JSON.stringify(fila.contenido), fila.nivel,
        fila.contenido.diaRelativo ?? null, fuente?.institucion ?? "Pendiente de validación profesional",
        fuente?.url ?? null, fuente?.fechaConsulta ?? null, m.id,
        fila.contenido.estado === "vigente" && fuente ? "validada" : "pendiente_validacion");
    }
  });
  transaccion();
  return filas.length;
}
