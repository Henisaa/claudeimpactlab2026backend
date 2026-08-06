/**
 * Horarios de medicación — zona horaria del plan.
 *
 * Prototipo: suficiente para que el worker materialice la toma de hoy en la
 * hora local escrita por el profesional ("10:00" en America/Santiago) y la
 * convierta a un instante UTC comparable con datetime('now').
 */

export function partesEnZona(fecha, zona) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const partes = Object.fromEntries(
    dtf
      .formatToParts(fecha)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    anio: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour) % 24,
    minuto: Number(partes.minute),
    segundo: Number(partes.second),
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Fecha y hora de "ahora" en la zona del plan, para guardar en las tomas. */
export function hoyEnZona(zona) {
  const p = partesEnZona(new Date(), zona);
  return {
    fechaLocal: `${p.anio}-${pad(p.mes)}-${pad(p.dia)}`,
    horaLocal: `${pad(p.hora)}:${pad(p.minuto)}`,
  };
}

/** Desplazamiento UTC de la zona en un instante dado (maneja el cambio de hora). */
function offsetMs(zona, fecha) {
  const p = partesEnZona(fecha, zona);
  const comoUtc = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - fecha.getTime();
}

/**
 * Instante real (Date) en que ocurre "horaLocal" del "fechaLocal" en la zona.
 * Ejemplo: "10:00" de hoy en America/Santiago → Date correcto en UTC.
 */
export function momentoUtcDesdeHoraLocal(zona, fechaLocal, horaLocal) {
  const [anio, mes, dia] = fechaLocal.split("-").map(Number);
  const [hora, minuto] = horaLocal.split(":").map(Number);
  const comoUtc = Date.UTC(anio, mes - 1, dia, hora, minuto, 0);
  return new Date(comoUtc - offsetMs(zona, new Date(comoUtc)));
}

/** "YYYY-MM-DD HH:MM:SS" en UTC, el formato que usa datetime('now') del backend. */
export function formatoUtc(fecha) {
  return fecha.toISOString().replace("T", " ").slice(0, 19);
}
