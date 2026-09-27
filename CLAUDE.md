# Backend — Contigo (Express + SQLite)

API REST del proyecto. Contexto general y reglas no negociables: `../CLAUDE.md`.
Documentación de dominio: vault `../claudeimpactlab2026obsidian` (ver `00_Indice.md`).

## Comandos

```bash
npm install
npm run matriz   # exporta la matriz clínica desde el frontend a data/matriz-etc.json
npm run seed     # 8 casos sintéticos + usuarios demo + corpus RAG (BORRA y recarga la BD)
npm start        # http://localhost:4000   (npm run dev = con --watch)
npm test         # node --test → 19 tests, deben pasar 19/19
npm run evaluar  # métricas de los 8 casos en modo MOCK
```

Usuarios demo (clave `demo1234`): `paciente@demo`, `cuidador@demo`, `profesional@demo`.
Configuración: copiar `.env.example` a `.env`. `CLAUDE_MOCK=true` (defecto) no gasta API.

## Mapa del código (`src/`)

- `motor.js` — motor determinístico de alertas. **Port 1:1 del frontend** (`src/lib/motor.ts`); cambiar uno exige cambiar el otro.
- `claude.js` — llamadas a Claude: extracción por visión, RAG con Citations, lectura de medicamento; modo MOCK.
- `rag.js` — FTS5/BM25 local; distingue documentos del paciente / fuentes oficiales / notas del proyecto.
- `seguridad.js` — AES-256-GCM (campos, archivos, chunks RAG). `auth.js` — JWT + roles + consentimiento.
- `auditoria.js` — auditoría solo-insert (Ley 20.584). `notificaciones.js` — WhatsApp (`simulado` | `whatsapp_cloud` | `twilio`).
- `rutas/` — `baul`, `seguimiento`, `medicacion`, `visitas` (enfermera particular), `cpo24`, `derechos` (ARCO), `crud`, `admin`.
- `medicacion/comparar.js` — comparador determinístico; `workers/medicacion.js` — recordatorios.
- `schema.sql` — modelo (26+ tablas); `db.js` aplica migraciones idempotentes.

## Reglas de trabajo

- ESM (`"type": "module"`). Sin dependencias nuevas sin motivo.
- Todo endpoint autenticado audita; el acceso a otro paciente responde 403; sin consentimiento `uso_ia` no se procesa con IA.
- Un borrador extraído por Claude **no** entra al RAG hasta que una persona lo confirma.
- El mensaje de WhatsApp **nunca** lleva datos clínicos ni el nombre del paciente.
- Tras cambiar reglas o matriz: `npm run matriz`, `npm run seed`, `npm test`.
- No ejecutar `seed` contra una BD con datos que importen: la limpia.

## Cuidado

- Este repo tiene `node_modules/` y las `.db` versionados en git pese al `.gitignore` (ver `Bugs_y_Deuda.md` en el vault). No hacer `git add -A` a ciegas.
- Antes de afirmar "funciona", correr `npm test`.
- Bugs, decisiones y avances se anotan en el vault, no en este archivo.
