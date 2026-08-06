import "dotenv/config";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rutaEvaluacion = path.join(raiz, "data", "evaluacion.db");
process.env.DEMO_MODE = "true";
process.env.CLAUDE_MOCK = "true";
process.env.DB_PATH = rutaEvaluacion;
if (existsSync(rutaEvaluacion)) rmSync(rutaEvaluacion, { force: true });
if (existsSync(`${rutaEvaluacion}-wal`)) rmSync(`${rutaEvaluacion}-wal`, { force: true });
if (existsSync(`${rutaEvaluacion}-shm`)) rmSync(`${rutaEvaluacion}-shm`, { force: true });
mkdirSync(path.dirname(rutaEvaluacion), { recursive: true });

const { matriz, evaluar } = await import("./motor.js");
const m = matriz();
const base = { emergencia: "no", dolor: "mejor", herida: "igual", movilidad: "si_solo", medicamentos: "si" };
const casos = [
  ["SYN-ETC-0001", { ...base }],
  ["SYN-ETC-0002", { ...base, dolor: "mejor" }],
  ["SYN-ETC-0003", { ...base, medicamentos: "algunos" }],
  ["SYN-ETC-0004", { ...base, herida: "mas_roja" }],
  ["SYN-ETC-0005", { ...base, emergencia: "si" }],
  ["SYN-ETC-0006", { ...base, contacto24h: false }],
  ["SYN-ETC-0007", { ...base, apoyoCuidador: true }],
  ["SYN-ETC-0008", { ...base, emergencia: "si" }],
];
const coloresEsperados = new Map(casos.map(([id]) => [id, id === "SYN-ETC-0005" || id === "SYN-ETC-0008" ? "rojo" : "verde"]));
let correctos = 0;
let importantesDetectadas = 0;
let falsasAlarmas = 0;
const resultados = [];
for (const [caso, respuestas] of casos) {
  const resultado = evaluar(m, respuestas, 3);
  const esperado = coloresEsperados.get(caso);
  const correcto = resultado.color === esperado;
  if (correcto) correctos += 1;
  if (esperado === "rojo" && resultado.color === "rojo") importantesDetectadas += 1;
  if (esperado === "verde" && resultado.color !== "verde") falsasAlarmas += 1;
  resultados.push({ caso, color_obtenido: resultado.color, color_esperado: esperado, correcto, reglas_bloqueadas: resultado.reglasBloqueadas.length });
}
const metricas = {
  fecha: new Date().toISOString(),
  casos_correctos: `${correctos}/8`,
  alertas_importantes_detectadas: `${importantesDetectadas}/2`,
  falsas_alarmas: falsasAlarmas,
  precision: importantesDetectadas === 2 && falsasAlarmas === 0 ? "1.00" : (correctos / 8).toFixed(2),
  reglas_no_validadas_bloqueadas: resultados.reduce((total, caso) => total + caso.reglas_bloqueadas, 0),
  resultados,
};
writeFileSync(path.join(raiz, "data", "evaluacion-metricas.json"), JSON.stringify(metricas, null, 2));
console.log(`Casos correctos: ${metricas.casos_correctos}`);
console.log(`Alertas importantes detectadas: ${metricas.alertas_importantes_detectadas}`);
console.log(`Falsas alarmas: ${metricas.falsas_alarmas}`);
console.log(`Precisión: ${metricas.precision}`);
console.log(`Reglas no validadas bloqueadas y reportadas: ${metricas.reglas_no_validadas_bloqueadas}`);
for (const resultado of resultados) console.log(`${resultado.caso}: ${resultado.color_obtenido} (${resultado.correcto ? "correcto" : "incorrecto"})`);
