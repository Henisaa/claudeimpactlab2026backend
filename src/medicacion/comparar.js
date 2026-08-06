/**
 * Comparador determinístico de medicamentos (prototipo).
 *
 * Esta es la pieza que decide si el texto visible en la fotografía "coincide"
 * con el plan aprobado. Es un motor de reglas puro, sin llamadas al modelo:
 * misma entrada, misma salida, siempre (la misma decisión de diseño que
 * motor.js con las alertas del check-in).
 *
 * Lo que el comparador NO hace, por diseño del proyecto:
 *   - no calcula ni sugiere dosis;
 *   - no convierte unidades automáticamente (solo normaliza mg/mcg/g para
 *     poder comparar "10 mg" con "10mg");
 *   - no decide que una marca es equivalente a un genérico;
 *   - no modifica el plan;
 *   - nunca produce un diagnóstico: todo resultado lleva
 *     requiere_revision_profesional = true.
 */

export function normalizarTexto(valor) {
  return String(valor ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Concentración a una unidad común (mg) para comparar "10 mg" con "10mg". */
function concentracionEnMg(valor) {
  const m = String(valor ?? "").match(/(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|g)/i);
  if (!m) return null;
  const numero = parseFloat(m[1].replace(",", "."));
  const unidad = m[2].toLowerCase();
  let factor = 1;
  if (unidad === "g") factor = 1000;
  if (unidad === "mcg" || unidad === "ug") factor = 0.001;
  return Math.round(numero * factor * 100) / 100;
}

function noSePuede(motivo) {
  return { resultado: "no_se_puede_confirmar", motivo, requiere_revision_profesional: true };
}

/**
 * @param plan      { medicamento_nombre, concentracion } (ya descifrado)
 * @param observado { nombre: { valor, confianza }, concentracion: { valor, confianza } }
 * @returns { resultado, motivo, requiere_revision_profesional }
 */
export function compararMedicamento(plan, observado) {
  if (!plan?.medicamento_nombre) return noSePuede("No hay plan aprobado para comparar.");

  const nombreObservado = String(observado?.nombre?.valor ?? "").trim();
  const concentracionObservada = String(observado?.concentracion?.valor ?? "").trim();
  const confianzaNombre = observado?.nombre?.confianza;

  if (!nombreObservado && !concentracionObservada) {
    return noSePuede("La foto no permitió leer el nombre ni la concentración del envase.");
  }
  if (nombreObservado && confianzaNombre === "baja") {
    return noSePuede("El nombre que se alcanza a leer tiene poca legibilidad; no se confirma automáticamente.");
  }

  const nombrePlan = normalizarTexto(plan.medicamento_nombre);
  const nombreFoto = normalizarTexto(nombreObservado);
  const nombreCoincide =
    !nombreFoto ||
    nombrePlan.includes(nombreFoto) ||
    nombreFoto.includes(nombrePlan);

  const cPlan = concentracionEnMg(plan.concentracion);
  const cFoto = concentracionEnMg(concentracionObservada);
  const concentracionCoincide = cFoto === null || cPlan === null || Math.abs(cFoto - cPlan) <= 0.01;

  const diferencias = [];
  if (nombreFoto && !nombreCoincide) {
    diferencias.push(`nombre (plan: "${plan.medicamento_nombre}", foto: "${nombreObservado}")`);
  }
  if (cFoto !== null && cPlan !== null && !concentracionCoincide) {
    diferencias.push(`concentración (plan: "${plan.concentracion}", foto: "${concentracionObservada}")`);
  }

  if (diferencias.length > 0) {
    return {
      resultado: "no_coincide",
      motivo: `Se detectó una diferencia: ${diferencias.join("; ")}. Requiere revisión del equipo de salud.`,
      requiere_revision_profesional: true,
    };
  }

  if (cFoto === null) {
    return {
      resultado: "coincide",
      motivo: "El nombre visible coincide con el plan registrado; la concentración no se leyó en la foto.",
      requiere_revision_profesional: true,
    };
  }

  return {
    resultado: "coincide",
    motivo: "El nombre y la concentración visibles coinciden con el plan registrado.",
    requiere_revision_profesional: true,
  };
}
