# Backend — Continuidad postoperatoria ETC

Claude Impact Lab 2026, Línea 03. API REST que implementa el núcleo de
`BACKEND_IDEALIZADO.md` (vault del proyecto): baúl persistente, roles,
consentimiento, auditoría, check-ins con motor determinístico, alertas y el
RAG del baúl.

Express + SQLite vía `node:sqlite` (incluido en Node ≥ 24: sin dependencias
nativas que compilar). La base es `data/prototipo.db`, cuyo esquema de 17
tablas ya seguía el modelo del backend idealizado.

## Correr

```bash
npm install
npm run matriz   # exporta la matriz clínica desde el frontend (fuente de verdad)
npm run seed     # 8 casos sintéticos + usuarios demo + corpus RAG oficial
npm start        # http://localhost:4000
```

`.env` requiere `ANTHROPIC_API_KEY` (para extracción y RAG), `PORT` y
`JWT_SECRET`. El seed espera el vault en `../claudeimpactlab2026obsidian`
(configurable con `VAULT_DIR`).

Usuarios demo (clave `demo1234`):

| usuario | rol | ve |
|---|---|---|
| `paciente@demo` | paciente | su propio expediente (SYN-ETC-0001) |
| `cuidador@demo` | cuidador | solo a quien lo autorizó (SYN-ETC-0007) |
| `profesional@demo` | profesional | pacientes de su establecimiento + alertas |

## La decisión de arquitectura que manda (heredada del proyecto)

**La alerta no la decide un modelo de lenguaje.** `src/motor.js` es el port
1:1 del motor del frontend: determinístico, sin llamadas al modelo, y solo
evalúa reglas con fuente clínica verificada. La matriz se consume desde
`data/matriz-etc.json`, exportada del frontend con `npm run matriz` — una
sola fuente de verdad.

## El RAG del baúl

Recuperación léxica local (SQLite FTS5, BM25, sin servicio de embeddings)
sobre dos colecciones que la respuesta siempre distingue:

1. **Documentos del paciente** — solo lo que una persona confirmó contra el
   papel. Un borrador extraído por Claude no entra al índice.
2. **Corpus oficial** — fuentes MINSAL/DEIS del vault + filas de la matriz
   clínica que tienen fuente.

`POST /pacientes/:id/preguntar` recupera los mejores fragmentos y Claude
(claude-sonnet-5) redacta en lenguaje simple **citando [n] cada afirmación**;
sin respaldo recuperado, responde "información insuficiente". No diagnostica,
no evalúa gravedad, no toca dosis; toda respuesta lleva
`requiere_revision_profesional`.

## Flujo de un documento fotografiado

```
POST /pacientes/:id/documentos      foto → Claude visión (claude-opus-5)
                                    → BORRADOR en trazabilidad_extraccion
POST /documentos/:id/confirmar      una persona lo compara con el papel
                                    → confirmado = 1 → recién ahí se indexa al RAG
```

## Endpoints

```
POST /api/v1/auth/login
GET  /api/v1/pacientes/:id/baul                    expediente compuesto
POST /api/v1/pacientes/:id/documentos              foto → extracción (consent uso_ia)
POST /api/v1/documentos/:id/confirmar              borrador → baúl + índice RAG
POST /api/v1/pacientes/:id/preguntar               RAG con citas (consent uso_ia)
GET  /api/v1/pacientes/:id/checkin-hoy             preguntas del día
POST /api/v1/pacientes/:id/checkins                evalúa (motor), persiste, alerta
GET  /api/v1/alertas                               según rol
POST /api/v1/alertas/:id/atender                   solo profesional, acción documentada
GET|POST /api/v1/pacientes/:id/consentimientos     Decreto 31 (otorgar/revocar)
GET  /api/v1/pacientes/:id/mis-datos               acceso + portabilidad (Ley 21.719)
GET  /api/v1/matriz                                matriz + huecos
```

Todo endpoint autenticado audita en `auditoria_acceso` (Ley 20.584). El
acceso a otro paciente responde 403; el consentimiento faltante bloquea el
procesamiento con IA.

## Reglas del proyecto (no negociables)

- Solo datos sintéticos. Cero PII real; el extractor rechaza transcribirla.
- Toda afirmación clínica con fuente verificable, o marcada insuficiente.
- Sin diagnóstico ni indicación médica autónoma; dosis solo transcritas.
- El profesional permanece en el circuito: ninguna alerta se cierra sin
  acción documentada.

## Pendiente

- Encriptación a nivel de aplicación de campos sensibles (§6 del idealizado).
- Notificaciones reales de escalamiento (SMS/WhatsApp) y reglas de reintento.
- Derecho de supresión con excepciones legales (§8.3).
- `node_modules/` está versionado por error en git; conviene
  `git rm -r --cached node_modules` en un commit de limpieza.
