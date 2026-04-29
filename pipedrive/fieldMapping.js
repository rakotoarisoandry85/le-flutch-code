'use strict';

/**
 * pipedrive/fieldMapping.js
 * Cartographie des champs Pipedrive ↔ colonnes internes.
 *
 * Convention de nommage des hash Pipedrive :
 *   - Champs standards : clés sémantiques (ex: 'title', 'value')
 *   - Champs custom    : hash alphanumérique (ex: 'abc12345678901234567')
 *                        → À récupérer via GET /dealFields ou /personFields
 *
 * NOTE : Les hash custom sont propres à chaque compte Pipedrive.
 *        Ils doivent être définis dans les variables d'environnement
 *        ou récupérés dynamiquement via getBienKeys() / getAcqKeys().
 */

// ─── Mapping statique — Biens (Deals Pipedrive) ───────────────────────────────

/**
 * Champs fixes des Deals — toujours présents, clés sémantiques stables.
 * @type {Record<string, string>}
 */
const BIEN_KEYS_STATIC = {
  pipedrive_id:  'id',
  titre:         'title',
  prix:          'value',
  devise:        'currency',
  statut:        'status',
  pipeline_id:   'pipeline_id',
  stage_id:      'stage_id',
  owner_id:      'user_id',
  person_id:     'person_id',
  org_id:        'org_id',
  created_at:    'add_time',
  updated_at:    'update_time',
  close_time:    'close_time',
};

/**
 * Champs custom des Deals (hash Pipedrive propres au compte).
 * Surchargeables via variables d'environnement pour chaque déploiement.
 *
 * Convention : PIPEDRIVE_DEAL_FIELD_{NOM_INTERNE}=<hash>
 */
const BIEN_KEYS_CUSTOM = {
  surface:         process.env.PIPEDRIVE_DEAL_FIELD_SURFACE         ?? '12345678901234a',
  nb_pieces:       process.env.PIPEDRIVE_DEAL_FIELD_NB_PIECES       ?? '12345678901234b',
  type_bien:       process.env.PIPEDRIVE_DEAL_FIELD_TYPE_BIEN       ?? '12345678901234c',
  localisation:    process.env.PIPEDRIVE_DEAL_FIELD_LOCALISATION    ?? '12345678901234d',
  code_postal:     process.env.PIPEDRIVE_DEAL_FIELD_CODE_POSTAL     ?? '12345678901234e',
  ville:           process.env.PIPEDRIVE_DEAL_FIELD_VILLE           ?? '12345678901234f',
  etage:           process.env.PIPEDRIVE_DEAL_FIELD_ETAGE           ?? '12345678901234g',
  nb_etages:       process.env.PIPEDRIVE_DEAL_FIELD_NB_ETAGES       ?? '12345678901234h',
  annee_construction: process.env.PIPEDRIVE_DEAL_FIELD_ANNEE_CONSTRUCTION ?? '12345678901234i',
  meuble:          process.env.PIPEDRIVE_DEAL_FIELD_MEUBLE          ?? '12345678901234j',
  // ── [AJOUT DPE] ─────────────────────────────────────────────────────────────
  dpe_classe:      process.env.PIPEDRIVE_DEAL_FIELD_DPE             ?? '12345678901234k',
  // ── Photos / liens ──────────────────────────────────────────────────────────
  photo_url:       process.env.PIPEDRIVE_DEAL_FIELD_PHOTO_URL       ?? '12345678901234l',
  lien_annonce:    process.env.PIPEDRIVE_DEAL_FIELD_LIEN_ANNONCE    ?? '12345678901234m',
};

// ─── Mapping statique — Acquéreurs (Persons Pipedrive) ────────────────────────

/**
 * Champs fixes des Persons.
 */
const ACQ_KEYS_STATIC = {
  pipedrive_id: 'id',
  nom:          'name',
  email:        'email',       // tableau [{value, primary, label}]
  telephone:    'phone',       // tableau [{value, primary, label}]
  created_at:   'add_time',
  updated_at:   'update_time',
  owner_id:     'owner_id',
};

/**
 * Champs custom des Persons (critères de recherche acquéreur).
 */
const ACQ_KEYS_CUSTOM = {
  budget_min:      process.env.PIPEDRIVE_PERSON_FIELD_BUDGET_MIN      ?? 'ab1234567890001',
  budget_max:      process.env.PIPEDRIVE_PERSON_FIELD_BUDGET_MAX      ?? 'ab1234567890002',
  surface_min:     process.env.PIPEDRIVE_PERSON_FIELD_SURFACE_MIN     ?? 'ab1234567890003',
  surface_max:     process.env.PIPEDRIVE_PERSON_FIELD_SURFACE_MAX     ?? 'ab1234567890004',
  nb_pieces_min:   process.env.PIPEDRIVE_PERSON_FIELD_NB_PIECES_MIN   ?? 'ab1234567890005',
  types_bien:      process.env.PIPEDRIVE_PERSON_FIELD_TYPES_BIEN      ?? 'ab1234567890006',
  villes:          process.env.PIPEDRIVE_PERSON_FIELD_VILLES          ?? 'ab1234567890007',
  codes_postaux:   process.env.PIPEDRIVE_PERSON_FIELD_CODES_POSTAUX   ?? 'ab1234567890008',
  // ── [AJOUT DPE] ─────────────────────────────────────────────────────────────
  // Pipedrive stocke les DPE acceptés comme une enum multi-sélection ou JSON string
  dpe_classes:     process.env.PIPEDRIVE_PERSON_FIELD_DPE             ?? 'ab1234567890009',
};

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Retourne le mapping complet des champs biens (statique + custom).
 * @returns {{ static: Record<string, string>, custom: Record<string, string> }}
 */
function getBienKeys() {
  return {
    static: { ...BIEN_KEYS_STATIC },
    custom: { ...BIEN_KEYS_CUSTOM },
  };
}

/**
 * Retourne le mapping complet des champs acquéreurs (statique + custom).
 * @returns {{ static: Record<string, string>, custom: Record<string, string> }}
 */
function getAcqKeys() {
  return {
    static: { ...ACQ_KEYS_STATIC },
    custom: { ...ACQ_KEYS_CUSTOM },
  };
}

/**
 * Extrait la valeur d'un champ interne depuis un objet brut Pipedrive.
 *
 * @param {object} pipedriveObj  - Objet brut retourné par l'API Pipedrive
 * @param {string} internalKey   - Clé interne (ex: 'dpe_classe')
 * @param {'bien'|'acquereur'} type
 * @returns {unknown}
 */
function extractField(pipedriveObj, internalKey, type = 'bien') {
  const keys = type === 'bien'
    ? { ...BIEN_KEYS_STATIC, ...BIEN_KEYS_CUSTOM }
    : { ...ACQ_KEYS_STATIC, ...ACQ_KEYS_CUSTOM };

  const pipedriveKey = keys[internalKey];
  if (!pipedriveKey) return undefined;
  return pipedriveObj[pipedriveKey];
}

module.exports = {
  getBienKeys,
  getAcqKeys,
  extractField,
  // Exports individuels pour les tests
  BIEN_KEYS_STATIC,
  BIEN_KEYS_CUSTOM,
  ACQ_KEYS_STATIC,
  ACQ_KEYS_CUSTOM,
};