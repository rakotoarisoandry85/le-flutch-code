'use strict';

// /**
//  * Sync batch Pipedrive → PostgreSQL.
//  * syncBiens : synchronise les biens depuis un stage donné.
//  * syncAcquereurs : synchronise les acquéreurs depuis un pipeline/stage.
//  */

const { logger } = require('../lib/logger');
const { pool, log } = require('../db');
const { pdGet } = require('./client');
const {
  //getDealFieldsMap,
  norm,
  findPipelineId,
  findStageId,
  OCC_LABELS,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  ACQ_KEYS,
  resolveSet,
  resolveEnum,
} = require('./fieldMapping');

async function syncBiens(apiToken, stageName = 'Commercialisé', userId = null, pipelineName = null) {
  logger.info('🔄 Sync biens...');

  let pipelineIdFilter = null;
  if (pipelineName) {
    pipelineIdFilter = await findPipelineId(pipelineName, apiToken);
    if (!pipelineIdFilter) logger.warn(`⚠️ Pipeline "${pipelineName}" introuvable, recherche de l'étape dans tous les pipelines`);
  }

  const stageId = await findStageId(stageName, apiToken, pipelineIdFilter);
  if (!stageId) throw new Error(`Étape "${stageName}" introuvable${pipelineName ? ` dans le pipeline "${pipelineName}"` : ''}`);

  const fieldMap = await getDealFieldsMap(apiToken);
  const findKey = (name) => Object.entries(fieldMap).find(([, v]) => norm(v) === norm(name))?.[0];

  const ADRESSE_FIELD = '7dae704151dd042a6dfef1c152b03670441a0332';
  const KEYS = {
    adresse: ADRESSE_FIELD, code_postal: ADRESSE_FIELD + '_postal_code', ville: ADRESSE_FIELD + '_locality',
    prix_fai: 'e47953f94beac00febac89a76afb3860cdb51fef',
    rentabilite_post_rev: 'd90975abce5b5abb909d65bba327ec4936c2da0e',
    occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
    mandat: 'e00ab03bb0bfdb3118bddfb18d02c02036c8a49d',
    surface: findKey('Surface') || findKey('surface'),
    nb_pieces: findKey('Nombre de pièces') || findKey('Pièces') || findKey('pieces'),
    type_bien: findKey('Type de bien') || findKey('Type'),
    etage: findKey('Étage') || findKey('Etage'),
    ascenseur: findKey('Ascenseur'), balcon: findKey('Balcon'), terrasse: findKey('Terrasse'),
    jardin: findKey('Jardin'), parking: findKey('Parking'), cave: findKey('Cave'),
    photo_1: findKey('Photo 1') || findKey('Photo principale'),
    photo_2: findKey('Photo 2'), photo_3: findKey('Photo 3'), photo_4: findKey('Photo 4'),
    autre_photo: findKey('Autre photo'),
    description: findKey('Description') || findKey('Descriptif'),
    classe_actifs: 'fddda5e38e41f34e60fa29e673fdfcb616400714',
    qualite_emplacement: '7c1fc74a248984e86233964b915267757dac7463',
    regime_propriete: 'bf3b56e01ab05315c1bf7e594f98353c9cc83b72',
    taxe_fonciere: '68952aa99715f630b6008951f5456149e68862e8',
    imputation_taxe_fonciere: 'db1cbc34063f81940f220f385113fd9ace7f22af',
    charge_annuelle: findKey('Charge annuelle') || findKey('Charges annuelles'),
    loyer_net_bailleur: '992e4b7155938077abd257eb335e1636ed23cada',
    prise_effet_bail: '5184aff71c51c12733aa7ae70ded5d6258d5fd21',
    loyer_post_revision: findKey('Loyer post-révision') || findKey('Loyer post revision') || findKey('Loyer post-revision'),
    assujettissement_tva: 'd80001fb080f075131f7c6913793b12214bd59ed',
    modalite_augmentation: 'b5d60aa066361be0ee3daab054712b9f0942d475',
    point_vigilance: 'f85f09a9b00fee2068b49e35fe65ca7adcec40b0',
    points_positifs: '6cbc95083ce14b748ba74dc5c65d4f25e3d060c6',
    surface_totale: 'e076db25cd27a7063fbaefda83beadf05dc6d164',
    surface_rdc: '9e8f4aa6c60543d2a263433f38fda0b21822da52',
    surface_etage: '239568e5ae63df64edd731ef1fa25db4cf76d2d8',
    surface_sous_sol: 'f25ee0c5cc58626b06ed1bbbcea550cdce5fd3c2',
    surface_ponderee: 'd2291bf2e4450ce095d3223d0467da9dea6fa2f1',
    rentabilite_actuelle: '3760c7c6ceef3dbf3c9f02e45b1645f9e2474311',
    descriptif: '64a1fc355d42e14a523831810120de6f6f831009',
    lien_drive: '6892d428773133b48a4a8b441548f038c7bf214c',
    photo_couverture: 'ed56fa0611b44379812c33dc28635f8ba0506c26',
    photo_2_real: 'e332d3138ff156857f74e3200bfa95ff740e1d41',
    photo_3_real: 'fd5c069993e79456623057d9d96060aa53f2c875',
  };

  let allDeals = [];
  let start = 0;
  const limit = 200;
  let moreItems = true;
  while (moreItems) {
    const data = await pdGet(`/deals?stage_id=${stageId}&status=open&start=${start}&limit=${limit}`, apiToken);
    if (!data?.data?.length) break;
    allDeals = allDeals.concat(data.data);
    moreItems = data.additional_data?.pagination?.more_items_in_collection;
    start += limit;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const deal of allDeals) {
      const g = (key) => key ? deal[key] : null;
      const toFloat = (v) => v ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;
      const toBool = (v) => v === true || v === 'Oui' || v === '1' || v === 1 ? 1 : 0;

      const cp = g(KEYS.code_postal) || null;
      const rawOcc = g(KEYS.occupation);
      const occIdStr = rawOcc ? String(rawOcc).split(',')[0].trim() : null;
      const occId = occIdStr ? parseInt(occIdStr) : null;
      const occLabel = occId ? (OCC_LABELS[occId] || String(rawOcc)) : null;
      const rawMandat = g(KEYS.mandat);
      const mandatId = rawMandat ? parseInt(String(rawMandat)) : null;
      const isDeleg = mandatId === 387 ? 1 : 0;

      const resolvedModalite = resolveSet(g(KEYS.modalite_augmentation), MODALITE_LABELS);
      const resolvedTva = resolveEnum(g(KEYS.assujettissement_tva), TVA_LABELS);
      const resolvedImputTF = resolveSet(g(KEYS.imputation_taxe_fonciere), IMPUT_TF_LABELS);
      const descriptif = g(KEYS.descriptif) || null;
      const lienDrive = g(KEYS.lien_drive) || null;
      const photoCouv = g(KEYS.photo_couverture) || g(KEYS.photo_1) || null;
      const photo2 = g(KEYS.photo_2_real) || g(KEYS.photo_2) || null;
      const photo3 = g(KEYS.photo_3_real) || g(KEYS.photo_3) || null;

      await client.query(`
        INSERT INTO biens (pipedrive_deal_id, titre, adresse, code_postal, ville, prix_fai, rentabilite,
          rentabilite_post_rev, occupation_status, occupation_id, mandat_id, surface, nombre_pieces,
          type_bien, etage, ascenseur, balcon, terrasse, jardin, parking, cave, description,
          photo_1, photo_2, photo_3, photo_4, autre_photo,
          is_delegation, pipeline_stage, owner_id, owner_email, owner_name,
          taxe_fonciere, charge_annuelle, loyer_net_bailleur, prise_effet_bail,
          loyer_post_revision, assujettissement_tva, modalite_augmentation,
          point_vigilance, points_positifs,
          surface_rdc, surface_etage, surface_sous_sol, surface_ponderee,
          imputation_taxe_fonciere, rentabilite_actuelle, lien_drive,
          pipedrive_updated_at, pipedrive_created_at, synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,NOW())
        ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
          titre=EXCLUDED.titre, adresse=EXCLUDED.adresse, code_postal=EXCLUDED.code_postal,
          ville=EXCLUDED.ville, prix_fai=EXCLUDED.prix_fai, rentabilite=EXCLUDED.rentabilite,
          rentabilite_post_rev=EXCLUDED.rentabilite_post_rev,
          occupation_status=EXCLUDED.occupation_status, occupation_id=EXCLUDED.occupation_id,
          mandat_id=EXCLUDED.mandat_id, surface=EXCLUDED.surface,
          nombre_pieces=EXCLUDED.nombre_pieces, type_bien=EXCLUDED.type_bien, etage=EXCLUDED.etage,
          ascenseur=EXCLUDED.ascenseur, balcon=EXCLUDED.balcon, terrasse=EXCLUDED.terrasse,
          jardin=EXCLUDED.jardin, parking=EXCLUDED.parking, cave=EXCLUDED.cave,
          description=EXCLUDED.description, photo_1=EXCLUDED.photo_1, photo_2=EXCLUDED.photo_2,
          photo_3=EXCLUDED.photo_3, photo_4=EXCLUDED.photo_4, autre_photo=EXCLUDED.autre_photo,
          is_delegation=EXCLUDED.is_delegation, owner_id=EXCLUDED.owner_id,
          owner_email=EXCLUDED.owner_email, owner_name=EXCLUDED.owner_name,
          taxe_fonciere=EXCLUDED.taxe_fonciere, charge_annuelle=EXCLUDED.charge_annuelle,
          loyer_net_bailleur=EXCLUDED.loyer_net_bailleur, prise_effet_bail=EXCLUDED.prise_effet_bail,
          loyer_post_revision=EXCLUDED.loyer_post_revision, assujettissement_tva=EXCLUDED.assujettissement_tva,
          modalite_augmentation=EXCLUDED.modalite_augmentation,
          point_vigilance=EXCLUDED.point_vigilance, points_positifs=EXCLUDED.points_positifs,
          surface_rdc=EXCLUDED.surface_rdc, surface_etage=EXCLUDED.surface_etage,
          surface_sous_sol=EXCLUDED.surface_sous_sol, surface_ponderee=EXCLUDED.surface_ponderee,
          imputation_taxe_fonciere=EXCLUDED.imputation_taxe_fonciere,
          rentabilite_actuelle=EXCLUDED.rentabilite_actuelle,
          lien_drive=EXCLUDED.lien_drive,
          pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
          pipedrive_created_at=EXCLUDED.pipedrive_created_at,
          synced_at=NOW()
      `, [
        deal.id, deal.title || '', g(KEYS.adresse) || deal.title, cp, g(KEYS.ville),
        toFloat(g(KEYS.prix_fai)) || toFloat(deal.value), null,
        toFloat(g(KEYS.rentabilite_post_rev)), occLabel, occId ? String(occId) : null,
        mandatId, toFloat(g(KEYS.surface_totale)) || toFloat(g(KEYS.surface)),
        g(KEYS.nb_pieces) ? parseInt(g(KEYS.nb_pieces)) : null,
        g(KEYS.type_bien), g(KEYS.etage) ? parseInt(g(KEYS.etage)) : null,
        toBool(g(KEYS.ascenseur)), toBool(g(KEYS.balcon)), toBool(g(KEYS.terrasse)),
        toBool(g(KEYS.jardin)), toBool(g(KEYS.parking)), toBool(g(KEYS.cave)),
        descriptif, photoCouv, photo2, photo3,
        g(KEYS.photo_4), g(KEYS.autre_photo),
        isDeleg, stageName, deal.user_id?.id || null, deal.user_id?.email || null,
        deal.user_id?.name || null,
        toFloat(g(KEYS.taxe_fonciere)), toFloat(g(KEYS.charge_annuelle)),
        toFloat(g(KEYS.loyer_net_bailleur)), g(KEYS.prise_effet_bail) || null,
        toFloat(g(KEYS.loyer_post_revision)), resolvedTva,
        resolvedModalite, g(KEYS.point_vigilance) || null,
        g(KEYS.points_positifs) || null,
        toFloat(g(KEYS.surface_rdc)), toFloat(g(KEYS.surface_etage)),
        toFloat(g(KEYS.surface_sous_sol)), toFloat(g(KEYS.surface_ponderee)),
        resolvedImputTF, toFloat(g(KEYS.rentabilite_actuelle)),
        lienDrive,
        deal.update_time || null, deal.add_time || null,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const currentIds = allDeals.map(d => d.id);
  let archivedCount = 0;
  if (currentIds.length) {
    const placeholders = currentIds.map((_, i) => `$${i + 1}`).join(',');
    const archResult = await pool.query(
      `UPDATE biens SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0`,
      currentIds
    );
    archivedCount = archResult.rowCount;
    await pool.query(
      `UPDATE biens SET archived = 0 WHERE pipedrive_deal_id IN (${placeholders}) AND archived = 1`,
      currentIds
    );
  } else {
    const archResult = await pool.query('UPDATE biens SET archived = 1 WHERE archived = 0');
    archivedCount = archResult.rowCount;
  }

  await pool.query('INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
    ['biens', 'ok', allDeals.length, `${stageName} · ${archivedCount} archivés`]);
  if (userId) await log(userId, 'sync_biens', 'sync', null, { count: allDeals.length, archived: archivedCount });
  logger.info(`✅ ${allDeals.length} biens synchronisés · ${archivedCount} archivés`);
  return allDeals.length;
}

async function syncAcquereurs(apiToken, pipelineNameOrId, userId = null, stageName = null) {
  logger.info('🔄 Sync acquéreurs...');
  const fieldMap = await getDealFieldsMap(apiToken);
  const findKey = (name) => Object.entries(fieldMap).find(([, v]) => norm(v) === norm(name))?.[0];

  const KEYS = ACQ_KEYS;

  let allDeals = [];
  let start = 0;
  const limit = 200;
  let moreItems = true;

  let pipelineId = null;
  if (typeof pipelineNameOrId === 'number' || /^\d+$/.test(pipelineNameOrId)) {
    pipelineId = parseInt(pipelineNameOrId);
  } else {
    pipelineId = await findPipelineId(pipelineNameOrId, apiToken);
  }
  if (!pipelineId) {
    logger.warn(`⚠️ Pipeline "${pipelineNameOrId}" introuvable, sync annulée`);
    return 0;
  }

  let stageIdFilter = null;
  if (stageName) {
    stageIdFilter = await findStageId(stageName, apiToken, pipelineId);
    if (!stageIdFilter) {
      logger.warn(`⚠️ Étape "${stageName}" introuvable dans le pipeline, fallback sur tout le pipeline`);
    }
  }

  while (moreItems) {
    const filterParam = stageIdFilter ? `stage_id=${stageIdFilter}` : `pipeline_id=${pipelineId}`;
    const data = await pdGet(`/deals?${filterParam}&status=open&start=${start}&limit=${limit}`, apiToken);
    if (!data?.data?.length) break;
    allDeals = allDeals.concat(data.data);
    moreItems = data.additional_data?.pagination?.more_items_in_collection;
    start += limit;
  }

  const OCC_MAP = { 333: 'Libre', 332: 'Occupé', 351: 'Libre', 352: 'Occupé', 353: 'Libre', 354: 'Occupé', 334: 'Location' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const deal of allDeals) {
      const g = (key) => key ? deal[key] : null;
      const toFloat = (v) => v ? parseFloat(String(v).replace(/[^0-9.]/g, '')) || null : null;

      await client.query(`
        INSERT INTO acquereurs (pipedrive_deal_id, titre, owner_id, owner_name, owner_email,
          contact_name, contact_email, contact_phone, contact_org,
          pipedrive_updated_at, pipedrive_created_at, synced_at, pipedrive_stage_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
        ON CONFLICT(pipedrive_deal_id) DO UPDATE SET
          titre=EXCLUDED.titre, owner_id=EXCLUDED.owner_id, owner_name=EXCLUDED.owner_name,
          owner_email=EXCLUDED.owner_email,
          contact_name=EXCLUDED.contact_name, contact_email=EXCLUDED.contact_email,
          contact_phone=EXCLUDED.contact_phone, contact_org=EXCLUDED.contact_org,
          pipedrive_updated_at=EXCLUDED.pipedrive_updated_at,
          pipedrive_created_at=EXCLUDED.pipedrive_created_at,
          synced_at=NOW(), pipedrive_stage_id=EXCLUDED.pipedrive_stage_id
      `, [
        deal.id, deal.title || '', deal.user_id?.id || null, deal.user_id?.name || '',
        deal.user_id?.email || null, deal.person_id?.name || '',
        deal.person_id?.email?.[0]?.value || '', deal.person_id?.phone?.[0]?.value || '',
        deal.org_id?.name || '', deal.update_time || null, deal.add_time || null,
        deal.stage_id || null,
      ]);

      const { rows: acqRows } = await client.query('SELECT id FROM acquereurs WHERE pipedrive_deal_id = $1', [deal.id]);
      const acq = acqRows[0];
      if (acq) {
        let secteurs = g(KEYS.secteurs);
        if (secteurs) {
          const arr = String(secteurs).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
          secteurs = JSON.stringify(arr);
        }
        const rawOcc = g(KEYS.occupation);
        let occIds = null;
        let occLabels = null;
        if (rawOcc) {
          const ids = String(rawOcc).split(',').map(s => s.trim()).filter(Boolean);
          occIds = JSON.stringify(ids);
          const labels = [...new Set(ids.map(id => OCC_MAP[parseInt(id)]).filter(Boolean))];
          occLabels = JSON.stringify(labels);
        }
        const rawCondPret = g(KEYS.condition_pret);
        const condPretLabel = rawCondPret === 320 || rawCondPret === '320' ? 'Oui'
                            : rawCondPret === 321 || rawCondPret === '321' ? 'Non' : null;

        await client.query(`
          INSERT INTO acquereur_criteria (acquereur_id, budget_min, budget_max, rentabilite_min,
            occupation_status, occupation_ids, secteurs, apport, condition_pret, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT(acquereur_id) DO UPDATE SET
            budget_min=EXCLUDED.budget_min, budget_max=EXCLUDED.budget_max,
            rentabilite_min=EXCLUDED.rentabilite_min,
            occupation_status=EXCLUDED.occupation_status,
            occupation_ids=EXCLUDED.occupation_ids, secteurs=EXCLUDED.secteurs,
            apport=EXCLUDED.apport, condition_pret=EXCLUDED.condition_pret,
            updated_at=NOW()
        `, [
          acq.id, toFloat(g(KEYS.budget_min)), toFloat(g(KEYS.budget_max)),
          toFloat(g(KEYS.rentabilite_min)), occLabels, occIds, secteurs || null,
          toFloat(g(KEYS.apport)), condPretLabel,
        ]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const currentIds = allDeals.map(d => d.id);
  const syncedStageId = stageIdFilter || null;
  let archivedCount = 0;
  if (currentIds.length) {
    const placeholders = currentIds.map((_, i) => `$${i + 1}`).join(',');
    if (syncedStageId) {
      const archResult = await pool.query(
        `UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0 AND pipedrive_stage_id = $${currentIds.length + 1}`,
        [...currentIds, syncedStageId]
      );
      archivedCount = archResult.rowCount;
    } else {
      const archResult = await pool.query(
        `UPDATE acquereurs SET archived = 1 WHERE pipedrive_deal_id NOT IN (${placeholders}) AND archived = 0`,
        currentIds
      );
      archivedCount = archResult.rowCount;
    }
    await pool.query(
      `UPDATE acquereurs SET archived = 0 WHERE pipedrive_deal_id IN (${placeholders}) AND archived = 1`,
      currentIds
    );
  } else {
    if (syncedStageId) {
      const archResult = await pool.query('UPDATE acquereurs SET archived = 1 WHERE archived = 0 AND pipedrive_stage_id = $1', [syncedStageId]);
      archivedCount = archResult.rowCount;
    } else {
      const archResult = await pool.query('UPDATE acquereurs SET archived = 1 WHERE archived = 0');
      archivedCount = archResult.rowCount;
    }
  }

  await pool.query('INSERT INTO sync_log (type, status, count, message) VALUES ($1, $2, $3, $4)',
    ['acquereurs', 'ok', allDeals.length, `${archivedCount} archivés`]);
  if (userId) await log(userId, 'sync_acquereurs', 'sync', null, { count: allDeals.length, archived: archivedCount });
  logger.info(`✅ ${allDeals.length} acquéreurs synchronisés · ${archivedCount} archivés`);
  return allDeals.length;
}

//module.exports = { syncBiens, syncAcquereurs };






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
//const logger = require('../lib/logger');
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

  syncBiens,
  syncAcquereurs,
};