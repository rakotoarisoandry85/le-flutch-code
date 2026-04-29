'use strict';

/**
 * tests/dpe.test.js
 * Tests unitaires pour les fonctions DPE de sync.js et matching.js
 */

const { normalizeDpe, parseDpeClasses } = require('../lib/dpe');

// ─── normalizeDpe ─────────────────────────────────────────────────────────────

describe('normalizeDpe()', () => {
  test.each([
    ['A', 'A'],
    ['b', 'B'],
    ['G', 'G'],
    [' C ', 'C'],
  ])('normalise la lettre brute "%s" → "%s"', (input, expected) => {
    expect(normalizeDpe(input)).toBe(expected);
  });

  test.each([
    ['Classe C', 'C'],
    ['DPE D',    'D'],
    ['classe E', 'E'],
    ['Classe B (bonne)', 'B'],
  ])('extrait la lettre depuis le texte libre "%s" → "%s"', (input, expected) => {
    expect(normalizeDpe(input)).toBe(expected);
  });

  test.each([
    [null,    null],
    ['',      null],
    [undefined, null],
    ['X',     null],
    ['H',     null],
    [42,      null],   // ID d'option enum Pipedrive → non supporté
  ])('retourne null pour valeur invalide : %s', (input, expected) => {
    expect(normalizeDpe(input)).toBe(expected);
  });
});

// ─── parseDpeClasses ──────────────────────────────────────────────────────────

describe('parseDpeClasses()', () => {
  test('parse un tableau JSON string', () => {
    expect(parseDpeClasses('["A","B","C"]')).toEqual(['A', 'B', 'C']);
  });

  test('parse un CSV', () => {
    expect(parseDpeClasses('A,B,C')).toEqual(['A', 'B', 'C']);
  });

  test('parse un tableau JavaScript', () => {
    expect(parseDpeClasses(['A', 'b', 'C'])).toEqual(['A', 'B', 'C']);
  });

  test('parse une valeur unique', () => {
    expect(parseDpeClasses('D')).toEqual(['D']);
  });

  test('filtre les valeurs invalides', () => {
    expect(parseDpeClasses(['A', 'X', 'B', ''])).toEqual(['A', 'B']);
  });

  test('retourne [] pour null/vide', () => {
    expect(parseDpeClasses(null)).toEqual([]);
    expect(parseDpeClasses('')).toEqual([]);
    expect(parseDpeClasses(undefined)).toEqual([]);
  });

  test('parse JSON malformé en fallback CSV', () => {
    expect(parseDpeClasses('[A,B')).toEqual(['A', 'B']);
  });
});

// ─── Logique SQL DPE (test de la logique en JS) ───────────────────────────────

describe('Logique filtre DPE (comportement attendu du WHERE SQL)', () => {
  /**
   * Simule la condition SQL :
   * dpe_classes IS NULL OR dpe_classes = [] OR dpe_classe IS NULL OR dpe_classes ? dpe_classe
   */
  function dpeSqlFilter(bienDpe, acqDpeClasses) {
    if (acqDpeClasses === null || acqDpeClasses === undefined) return true;
    if (acqDpeClasses.length === 0) return true;
    if (bienDpe === null || bienDpe === undefined) return true; // tolérance bien sans DPE
    return acqDpeClasses.includes(bienDpe);
  }

  test('acquéreur sans préférence DPE → tous les biens passent', () => {
    expect(dpeSqlFilter('G', [])).toBe(true);
    expect(dpeSqlFilter('G', null)).toBe(true);
  });

  test('bien sans DPE → toujours compatible (données incomplètes tolérées)', () => {
    expect(dpeSqlFilter(null, ['A', 'B'])).toBe(true);
  });

  test('DPE compatible → bien retenu', () => {
    expect(dpeSqlFilter('B', ['A', 'B', 'C'])).toBe(true);
  });

  test('DPE incompatible → bien exclu', () => {
    expect(dpeSqlFilter('F', ['A', 'B', 'C'])).toBe(false);
  });

  test('DPE G exclu si acquéreur veut A-D seulement', () => {
    expect(dpeSqlFilter('G', ['A', 'B', 'C', 'D'])).toBe(false);
  });
});