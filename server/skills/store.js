/**
 * Persistence for the skill library.
 *
 * SQLite via `node:sqlite` where it is available. Older supported Node releases
 * do not ship that module, so the store transparently falls back to a JSON
 * file. Skills are small, and the fallback keeps startup and normal operation
 * working across Node 20 and newer runtimes.
 *
 * The database lives in `server/.runtime/`, which is gitignored: a skill records
 * what someone actually did on their own phone, and that is not repository
 * content.
 */

import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { toBlob, fromBlob } from './embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(__dirname, '..', '.runtime');
const DB_FILE = path.join(RUNTIME_DIR, 'skills.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  task         TEXT NOT NULL,
  template     TEXT NOT NULL DEFAULT '',
  normalized   TEXT NOT NULL,
  app          TEXT,
  params_json  TEXT NOT NULL DEFAULT '[]',
  steps_json   TEXT NOT NULL,
  embedding    BLOB,
  uses         INTEGER NOT NULL DEFAULT 0,
  successes    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS skills_normalized ON skills (normalized);
`;

let db = null;
let DatabaseSync = null;

try {
  DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
} catch {
  // Node 20. Node 22.5+ and Node 24 expose node:sqlite.
}

class JsonDatabase {
  constructor(file) {
    this.file = file;
    this.rows = new Map();
    if (file !== ':memory:' && fs.existsSync(file)) {
      try {
        for (const row of JSON.parse(fs.readFileSync(file, 'utf8'))) {
          if (row.embedding?.type === 'Buffer' && Array.isArray(row.embedding.data)) {
            row.embedding = Buffer.from(row.embedding.data);
          }
          this.rows.set(row.id, row);
        }
      } catch {
        this.rows.clear();
      }
    }
  }

  exec() {}

  close() {}

  persist() {
    if (this.file === ':memory:') return;
    fs.writeFileSync(this.file, JSON.stringify([...this.rows.values()], null, 2));
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      run: (...params) => {
        let changes = 0;
        if (/^INSERT INTO skills/.test(normalized)) {
          const [id, name, task, template, normalizedTask, app, paramsJson, stepsJson, embedding, createdAt] = params;
          this.rows.set(id, {
            id, name, task, template, normalized: normalizedTask, app, params_json: paramsJson,
            steps_json: stepsJson, embedding, uses: 0, successes: 0,
            created_at: createdAt, last_used_at: null
          });
          changes = 1;
        } else if (/^UPDATE skills\s+SET name =/.test(normalized)) {
          const [name, task, template, app, paramsJson, stepsJson, embedding, id] = params;
          const row = this.rows.get(id);
          if (row) {
            Object.assign(row, {
              name, task, template, app, params_json: paramsJson, steps_json: stepsJson, embedding
            });
            changes = 1;
          }
        } else if (/^UPDATE skills\s+SET uses =/.test(normalized)) {
          const [successes, lastUsedAt, id] = params;
          const row = this.rows.get(id);
          if (row) {
            row.uses += 1;
            row.successes += successes;
            row.last_used_at = lastUsedAt;
            changes = 1;
          }
        } else if (/^DELETE FROM skills/.test(normalized)) {
          changes = this.rows.delete(params[0]) ? 1 : 0;
        }
        this.persist();
        return { changes };
      },
      get: (...params) => {
        if (/COUNT\(\*\) AS n/.test(normalized)) {
          return { n: this.rows.size };
        }
        if (/WHERE normalized =/.test(normalized)) {
          return [...this.rows.values()].find((row) => row.normalized === params[0]) ?? undefined;
        }
        if (/WHERE id =/.test(normalized)) {
          return this.rows.get(params[0]) ?? undefined;
        }
        return undefined;
      },
      all: (limit) => [...this.rows.values()]
        .sort((a, b) => (b.last_used_at ?? b.created_at) - (a.last_used_at ?? a.created_at))
        .slice(0, limit)
    };
  }
}

/** Open lazily so importing this module never touches the filesystem. */
export function getDb(file = DB_FILE) {
  if (db) return db;
  if (file !== ':memory:' && !fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
  db = DatabaseSync ? new DatabaseSync(file) : new JsonDatabase(file);
  db.exec(SCHEMA);
  return db;
}

/** Tests point the store at an in-memory database through this. */
export function useDatabase(instance) {
  db = instance;
  if (db) db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  try { db?.close(); } catch {  }
  db = null;
}

function toSkill(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    // Falling back to the raw task keeps rows written before templates
    // existed matchable, just without parameters.
    template: row.template || row.task,
    normalized: row.normalized,
    app: row.app || null,
    params: JSON.parse(row.params_json),
    steps: JSON.parse(row.steps_json),
    embedding: fromBlob(row.embedding),
    uses: row.uses,
    successes: row.successes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  };
}

/**
 * Insert, or replace the stored steps when the same normalized task is learned
 * again. A later run of the same task is the better recording: it is the one
 * that reflects how the app looks now.
 */
export function saveSkill(skill) {
  const conn = getDb();
  const existing = findByNormalized(skill.normalized);

  if (existing) {
    conn.prepare(`
      UPDATE skills
         SET name = ?, task = ?, template = ?, app = ?, params_json = ?, steps_json = ?, embedding = ?
       WHERE id = ?
    `).run(
      skill.name,
      skill.task,
      skill.template ?? skill.task,
      skill.app ?? null,
      JSON.stringify(skill.params ?? []),
      JSON.stringify(skill.steps ?? []),
      toBlob(skill.embedding),
      existing.id
    );
    return { ...existing, ...skill, id: existing.id };
  }

  conn.prepare(`
    INSERT INTO skills (id, name, task, template, normalized, app, params_json, steps_json, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skill.id,
    skill.name,
    skill.task,
    skill.template ?? skill.task,
    skill.normalized,
    skill.app ?? null,
    JSON.stringify(skill.params ?? []),
    JSON.stringify(skill.steps ?? []),
    toBlob(skill.embedding),
    Date.now()
  );
  return { ...skill, uses: 0, successes: 0 };
}

export function findByNormalized(normalized) {
  if (!normalized) return null;
  const row = getDb().prepare('SELECT * FROM skills WHERE normalized = ? LIMIT 1').get(normalized);
  return toSkill(row);
}

export function getSkill(id) {
  return toSkill(getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id));
}

export function listSkills({ limit = 100 } = {}) {
  return getDb()
    .prepare('SELECT * FROM skills ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT ?')
    .all(limit)
    .map(toSkill);
}

export function deleteSkill(id) {
  const info = getDb().prepare('DELETE FROM skills WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Outcome feedback. A skill that keeps failing on replay should stop being
 * trusted, so both counters are kept rather than just a use count.
 */
export function recordUse(id, ok) {
  getDb().prepare(`
    UPDATE skills
       SET uses = uses + 1,
           successes = successes + ?,
           last_used_at = ?
     WHERE id = ?
  `).run(ok ? 1 : 0, Date.now(), id);
}

export function countSkills() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM skills').get().n;
}
