import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function key() {
  const configured = process.env.ENCRYPTION_KEY;
  const demo = process.env.DEMO_MODE === "true" || process.env.NODE_ENV !== "production";
  if (!configured && !demo) {
    throw new Error("ENCRYPTION_KEY es obligatoria fuera del modo demo.");
  }
  return createHash("sha256")
    .update(configured ?? "demo-only-encryption-key-change-me")
    .digest();
}

export function cifrar(texto) {
  if (texto === null || texto === undefined) return texto;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const contenido = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), contenido]).toString("base64url");
}

export function descifrar(valor) {
  if (!valor) return valor;
  try {
    const buffer = Buffer.from(valor, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return valor;
  }
}

export function cifrarJson(valor) {
  return valor === null || valor === undefined ? valor : cifrar(JSON.stringify(valor));
}

export function descifrarJson(valor, respaldo = null) {
  if (valor === null || valor === undefined) return respaldo;
  try {
    return JSON.parse(descifrar(valor));
  } catch {
    return respaldo ?? valor;
  }
}

export function descifrarCampos(fila, campos) {
  if (!fila) return fila;
  const copia = { ...fila };
  for (const campo of campos) if (copia[campo] !== null && copia[campo] !== undefined) copia[campo] = descifrar(copia[campo]);
  return copia;
}

export function descifrarJsonCampos(fila, campos) {
  if (!fila) return fila;
  const copia = { ...fila };
  for (const campo of campos) copia[campo] = descifrarJson(copia[campo], []);
  return copia;
}

const PII = [
  /\b\d{7,8}-?[0-9kK]\b/g,
  /\b(?:\+?56\s?)?9\s?\d{4}\s?\d{4}\b/g,
  /\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\b/g,
];

export function detectarPII(texto) {
  const hallazgos = [];
  for (const patron of PII) {
    patron.lastIndex = 0;
    if (patron.test(String(texto))) hallazgos.push(patron.source);
    patron.lastIndex = 0;
  }
  return hallazgos;
}

export function anonimizar(texto) {
  let limpio = String(texto);
  for (const patron of PII) limpio = limpio.replace(patron, "[PII_OCULTA]");
  return limpio;
}

export function escribirArchivoCifrado(origen, destino) {
  const datos = readFileSync(origen);
  writeFileSync(destino, Buffer.from(cifrar(datos.toString("base64")), "utf8"));
}

export function leerArchivoCifrado(ruta) {
  return Buffer.from(descifrar(readFileSync(ruta, "utf8")), "base64");
}
