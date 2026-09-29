/**
 * Persistence for the skill library.
 *
 * SQLite via `node:sqlite`, which ships inside Node — so the project's "three
 * runtime dependencies" claim still holds. Skills are small but they accumulate
 * forever and are read on every agent run; rewriting a whole JSON file per
 * write (the pattern macros.js uses) does not survive that.
 *
 * The database lives in `server/.runtime/`, which is gitignored: a skill records
 * what someone actually did on their own phone, and that is not repository
 * content.
 */

import { DatabaseSync } from 'node:sqlite';
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

/** Open lazily so importing this module never touches the filesystem. */
export function getDb(file = DB_FILE) {
  if (db) return db;
  if (file !== ':memory:' && !fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
  db = new DatabaseSync(file);
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
