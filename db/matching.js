'use strict';

/**
 * pipedrive/sync.js
 * Synchronisation Pipedrive → PostgreSQL.
 *
 * Modifications DPE [AJOUT] :
 *   - normalizeDpe()      : valide et normalise la lettre DPE
 *   - parseDpeClasses()   : parse le tableau DPE d'un acquéreur
 *   - mapDealToDb()       : inclut dpe_classe
 *   - mapPersonCriteriaToDb() : inclut dpe_classes (JSONB)
 */

const db = require('../db');
const logger = require('../lib/logger');
const { withRetry } = require('../lib/retry');
const { BIEN_KEYS_CUSTOM, ACQ_KEYS_CUSTOM } = require('./fieldMapping');
const { normalizeDpe, parseDpeClasses } = require('../lib/dpe');

// ─── Helpers DPE — importés depuis lib/dpe.js ────────────────────────────────

// ─── Mapping Deal → DB ────────────────────────────────────────────────────────

/**
 * Transforme un objet Deal Pipedrive brut en objet DB.
 *
 * @param {object} deal   Objet deal retourné par l'API Pipedrive
 * @returns {object}      Colonnes DB prêtes à insérer
 */
function mapDealToDb(deal) {
  // Extraction champs custom via hash
  const getCustom = (key) => deal[BIEN_KEYS_CUSTOM[key]];

  return {
    pipedrive_id:       String(deal.id),
    titre:              deal.title ?? null,
    prix:               deal.value != null ? Number(deal.value) : null,
    devise:             deal.currency ?? 'EUR',
    statut:             normalizeDealStatus(deal.status),
    pipeline_id:        deal.pipeline_id ?? null,
    stage_id:           deal.stage_id ?? null,
    owner_id:           deal.user_id?.id ?? deal.user_id ?? null,
    surface:            getCustom('surface') != null ? Number(getCustom('surface')) : null,
    nb_pieces:          getCustom('nb_pieces') != null ? Number(getCustom('nb_pieces')) : null,
    type_bien:          getCustom('type_bien') ?? null,
    localisation:       getCustom('localisation') ?? null,
    code_postal:        getCustom('code_postal') ?? null,
    ville:              getCustom('ville') ?? null,
    // ── [AJOUT DPE] ──────────────────────────────────────────────────────────
    dpe_classe:         normalizeDpe(getCustom('dpe_classe')),
    // ─────────────────────────────────────────────────────────────────────────
    photo_url:          getCustom('photo_url') ?? null,
    lien_annonce:       getCustom('lien_annonce') ?? null,
    pipedrive_updated:  deal.update_time ?? null,
  };
}

/**
 * Normalise le statut Pipedrive vers le statut interne.
 * @param {string} status
 * @returns {string}
 */
function normalizeDealStatus(status) {
  const map = {
    open:    'actif',
    won:     'vendu',
    lost:    'perdu',
    deleted: 'archive',
  };
  return map[status] ?? 'actif';
}

// ─── Mapping Person/Criteria → DB ─────────────────────────────────────────────

/**
 * Transforme un objet Person Pipedrive en critères acquéreur DB.
 *
 * @param {object} person   Objet person retourné par l'API Pipedrive
 * @returns {object}        Colonnes DB pour acquereur_criteria
 */
function mapPersonCriteriaToDb(person) {
  const getCustom = (key) => person[ACQ_KEYS_CUSTOM[key]];

  const primaryEmail = Array.isArray(person.email)
    ? person.email.find((e) => e.primary)?.value ?? person.email[0]?.value
    : person.email ?? null;

  const primaryPhone = Array.isArray(person.phone)
    ? person.phone.find((p) => p.primary)?.value ?? person.phone[0]?.value
    : person.phone ?? null;

  return {
    // Champs acquéreur de base
    pipedrive_id: String(person.id),
    nom:          person.name ?? null,
    email:        primaryEmail,
    telephone:    primaryPhone,
    owner_id:     person.owner_id?.id ?? person.owner_id ?? null,

    // Critères de recherche
    budget_min:   getCustom('budget_min') != null ? Number(getCustom('budget_min')) : null,
    budget_max:   getCustom('budget_max') != null ? Number(getCustom('budget_max')) : null,
    surface_min:  getCustom('surface_min') != null ? Number(getCustom('surface_min')) : null,
    surface_max:  getCustom('surface_max') != null ? Number(getCustom('surface_max')) : null,
    nb_pieces_min: getCustom('nb_pieces_min') != null ? Number(getCustom('nb_pieces_min')) : null,
    types_bien:   parseJsonArray(getCustom('types_bien')),
    villes:       parseJsonArray(getCustom('villes')),
    codes_postaux: parseJsonArray(getCustom('codes_postaux')),
    // ── [AJOUT DPE] ──────────────────────────────────────────────────────────
    dpe_classes:  parseDpeClasses(getCustom('dpe_classes')),
    // ─────────────────────────────────────────────────────────────────────────
    pipedrive_updated: person.update_time ?? null,
  };
}

/**
 * Parse un champ Pipedrive en tableau JSON (multi-sélect ou CSV).
 * @param {unknown} rawValue
 * @returns {string[]}
 */
function parseJsonArray(rawValue) {
  if (rawValue == null || rawValue === '') return [];
  if (Array.isArray(rawValue)) return rawValue.map(String);
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map(String) : [String(rawValue)];
  } catch {
    return String(rawValue).split(',').map((s) => s.trim()).filter(Boolean);
  }
}

// ─── Upsert biens ─────────────────────────────────────────────────────────────

/**
 * Upsert d'un bien en base depuis un objet deal Pipedrive.
 *
 * @param {object} deal   Objet deal brut Pipedrive
 * @returns {Promise<object>}  Ligne DB insérée/mise à jour
 */
async function upsertBien(deal) {
  const data = mapDealToDb(deal);

  const result = await db.query(
    `INSERT INTO biens (
        pipedrive_id, titre, prix, devise, statut, pipeline_id, stage_id,
        owner_id, surface, nb_pieces, type_bien, localisation, code_postal,
        ville, dpe_classe, photo_url, lien_annonce, pipedrive_updated,
        created_at, updated_at
     ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        NOW(), NOW()
     )
     ON CONFLICT (pipedrive_id) DO UPDATE SET
        titre             = EXCLUDED.titre,
        prix              = EXCLUDED.prix,
        devise            = EXCLUDED.devise,
        statut            = EXCLUDED.statut,
        pipeline_id       = EXCLUDED.pipeline_id,
        stage_id          = EXCLUDED.stage_id,
        owner_id          = EXCLUDED.owner_id,
        surface           = EXCLUDED.surface,
        nb_pieces         = EXCLUDED.nb_pieces,
        type_bien         = EXCLUDED.type_bien,
        localisation      = EXCLUDED.localisation,
        code_postal       = EXCLUDED.code_postal,
        ville             = EXCLUDED.ville,
        dpe_classe        = EXCLUDED.dpe_classe,
        photo_url         = EXCLUDED.photo_url,
        lien_annonce      = EXCLUDED.lien_annonce,
        pipedrive_updated = EXCLUDED.pipedrive_updated,
        updated_at        = NOW()
     RETURNING *`,
    [
      data.pipedrive_id, data.titre, data.prix, data.devise, data.statut,
      data.pipeline_id, data.stage_id, data.owner_id, data.surface,
      data.nb_pieces, data.type_bien, data.localisation, data.code_postal,
      data.ville, data.dpe_classe, data.photo_url, data.lien_annonce,
      data.pipedrive_updated,
    ]
  );

  logger.debug('[sync] bien upserted', {
    pipedrive_id: data.pipedrive_id,
    dpe_classe: data.dpe_classe,
  });

  return result.rows[0];
}

/**
 * Upsert d'un acquéreur et de ses critères de recherche.
 *
 * @param {object} person   Objet person brut Pipedrive
 * @returns {Promise<object>}
 */
async function upsertAcquereur(person) {
  const data = mapPersonCriteriaToDb(person);

  // Transaction : upsert acquéreur + critères atomiquement
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert acquéreur
    const acqResult = await client.query(
      `INSERT INTO acquereurs (pipedrive_id, nom, email, telephone, owner_id, actif, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
       ON CONFLICT (pipedrive_id) DO UPDATE SET
         nom        = EXCLUDED.nom,
         email      = EXCLUDED.email,
         telephone  = EXCLUDED.telephone,
         owner_id   = EXCLUDED.owner_id,
         updated_at = NOW()
       RETURNING id`,
      [data.pipedrive_id, data.nom, data.email, data.telephone, data.owner_id]
    );

    const acquereurId = acqResult.rows[0].id;

    // 2. Upsert critères (incluant dpe_classes)
    await client.query(
      `INSERT INTO acquereur_criteria (
          acquereur_id, budget_min, budget_max, surface_min, surface_max,
          nb_pieces_min, types_bien, villes, codes_postaux, dpe_classes,
          updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
       ON CONFLICT (acquereur_id) DO UPDATE SET
          budget_min    = EXCLUDED.budget_min,
          budget_max    = EXCLUDED.budget_max,
          surface_min   = EXCLUDED.surface_min,
          surface_max   = EXCLUDED.surface_max,
          nb_pieces_min = EXCLUDED.nb_pieces_min,
          types_bien    = EXCLUDED.types_bien,
          villes        = EXCLUDED.villes,
          codes_postaux = EXCLUDED.codes_postaux,
          dpe_classes   = EXCLUDED.dpe_classes,
          updated_at    = NOW()`,
      [
        acquereurId,
        data.budget_min, data.budget_max, data.surface_min, data.surface_max,
        data.nb_pieces_min,
        JSON.stringify(data.types_bien),
        JSON.stringify(data.villes),
        JSON.stringify(data.codes_postaux),
        JSON.stringify(data.dpe_classes),   // [AJOUT DPE]
      ]
    );

    await client.query('COMMIT');

    logger.debug('[sync] acquéreur upserted', {
      pipedrive_id: data.pipedrive_id,
      dpe_classes: data.dpe_classes,
    });

    return { ...data, id: acquereurId };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[sync] erreur upsert acquéreur', { pipedrive_id: data.pipedrive_id, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ─── Sync complète (cron / manuel) ────────────────────────────────────────────

/**
 * Synchronise un seul deal depuis Pipedrive (utilisé par le Worker webhook).
 *
 * @param {string|number} dealId
 */
async function syncSingleDeal(dealId) {
  const { fetchDeal } = require('./client');   // client HTTP Pipedrive
  const deal = await withRetry(() => fetchDeal(dealId), { label: `fetchDeal#${dealId}` });
  if (!deal) {
    logger.warn('[sync] deal introuvable', { dealId });
    return null;
  }
  return upsertBien(deal);
}

/**
 * Synchronise une seule person depuis Pipedrive.
 *
 * @param {string|number} personId
 */
async function syncSinglePerson(personId) {
  const { fetchPerson } = require('./client');
  const person = await withRetry(() => fetchPerson(personId), { label: `fetchPerson#${personId}` });
  if (!person) {
    logger.warn('[sync] person introuvable', { personId });
    return null;
  }
  return upsertAcquereur(person);
}

module.exports = {
  // Helpers DPE (exportés pour tests unitaires)
  normalizeDpe,
  parseDpeClasses,
  // Mapping
  mapDealToDb,
  mapPersonCriteriaToDb,
  // Upserts
  upsertBien,
  upsertAcquereur,
  // Sync via webhook
  syncSingleDeal,
  syncSinglePerson,
};