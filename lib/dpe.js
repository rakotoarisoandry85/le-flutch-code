'use strict';

/**
 * lib/dpe.js
 * Helpers de normalisation DPE (Diagnostic de Performance Énergétique).
 * Isolés ici pour être importables indépendamment de pipedrive/sync.js.
 */

const DPE_VALID = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

/**
 * Normalise une valeur DPE brute provenant de Pipedrive.
 * Gère : "C", "c", "Classe C", "DPE D", etc.
 *
 * @param {unknown} rawValue
 * @returns {string|null}  Lettre A-G ou null si invalide/absent
 */
function normalizeDpe(rawValue) {
  if (rawValue == null || rawValue === '') return null;

  const str = String(rawValue).trim().toUpperCase();

  if (DPE_VALID.has(str)) return str;

  const match = str.match(/\b([A-G])\b/);
  if (match) return match[1];

  return null;
}

/**
 * Parse les classes DPE acceptées par un acquéreur.
 * Gère : '["A","B"]', "A,B,C", ["A","b","C"], "D"
 *
 * @param {unknown} rawValue
 * @returns {string[]}  Tableau filtré de lettres A-G valides
 */
function parseDpeClasses(rawValue) {
  if (rawValue == null || rawValue === '') return [];

  let arr = [];

  if (Array.isArray(rawValue)) {
    arr = rawValue;
  } else if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('[')) {
      try {
        arr = JSON.parse(trimmed);
      } catch {
        arr = trimmed.split(',').map((s) => s.trim());
      }
    } else {
      arr = trimmed.split(',').map((s) => s.trim());
    }
  }

  return arr.map((v) => normalizeDpe(v)).filter(Boolean);
}

module.exports = { normalizeDpe, parseDpeClasses, DPE_VALID };