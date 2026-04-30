'use strict';

const { pdGet } = require('./client');

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

const LEGACY_BIEN_KEYS = {
  adresse: '7dae704151dd042a6dfef1c152b03670441a0332',
  code_postal: '7dae704151dd042a6dfef1c152b03670441a0332_postal_code',
  ville: '7dae704151dd042a6dfef1c152b03670441a0332_locality',
  prix_fai: 'e47953f94beac00febac89a76afb3860cdb51fef',
  rentabilite_post_rev: 'd90975abce5b5abb909d65bba327ec4936c2da0e',
  occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
  mandat: 'e00ab03bb0bfdb3118bddfb18d02c02036c8a49d',
  taxe_fonciere: '68952aa99715f630b6008951f5456149e68862e8',
  imputation_taxe_fonciere: 'db1cbc34063f81940f220f385113fd9ace7f22af',
  loyer_net_bailleur: '992e4b7155938077abd257eb335e1636ed23cada',
  prise_effet_bail: '5184aff71c51c12733aa7ae70ded5d6258d5fd21',
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

const ACQ_KEYS = {
  budget_min: '4f22c33e84cb1e27c3f43e5c6113a3075b27a732',
  budget_max: '77536372ffdd85fad871278ffa82b56877cc8347',
  rentabilite_min: '0e23eafbe69625f6a4d8a8c56d07755a28dddaf1',
  occupation: 'ff88b708d9d16f9729825144ab907171364ef744',
  secteurs: '128fa9e5c711bd57384dccff920fb4b2fff28f8a',
  apport: 'cb21e7d0444ab342f723ab1061f247911a35bd06',
  condition_pret: '34dded16ece2a316aaebdbb8d7c9260c6a8dca37',
};

const OCC_MAP_SIMPLE = {
  332: 'Occupe',
  333: 'Libre',
  334: 'Location',
  351: 'Libre',
  352: 'Occupe',
  353: 'Libre',
  354: 'Occupe',
};

const OCC_LABELS = {
  ...OCC_MAP_SIMPLE,
  332: 'Occupe',
  352: 'Occupe',
  354: 'Occupe',
};

const TVA_LABELS = {
  335: 'Oui',
  336: 'Non',
};

const MODALITE_LABELS = {
  337: 'Fixe',
  338: 'Variable',
  339: 'ILC',
  340: 'ILAT',
  341: 'ICC',
};

const IMPUT_TF_LABELS = {
  342: 'Bailleur',
  343: 'Preneur',
  344: 'Partage',
};

let dealFieldsCache = null;

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function getDealFieldsMap(apiToken) {
  if (dealFieldsCache) return dealFieldsCache;
  const data = await pdGet('/dealFields', apiToken);
  dealFieldsCache = {};
  for (const field of data?.data || []) {
    if (field?.key && field?.name) dealFieldsCache[field.key] = field.name;
  }
  return dealFieldsCache;
}

function invalidateBienKeysCache() {
  dealFieldsCache = null;
}

function resolveSet(rawValue, labels = {}) {
  if (rawValue == null || rawValue === '') return null;
  const ids = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue).split(',').map((s) => s.trim()).filter(Boolean);
  const values = ids.map((id) => labels[id] || labels[Number(id)] || String(id));
  return values.length ? values.join(', ') : null;
}

function resolveEnum(rawValue, labels = {}) {
  if (rawValue == null || rawValue === '') return null;
  return labels[rawValue] || labels[Number(rawValue)] || String(rawValue);
}

async function findPipelineId(nameOrId, apiToken) {
  if (nameOrId == null || nameOrId === '') return null;
  if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) return Number(nameOrId);
  const data = await pdGet('/pipelines', apiToken);
  const found = (data?.data || []).find((pipeline) => norm(pipeline.name) === norm(nameOrId));
  return found?.id || null;
}

async function findStageId(stageNameOrId, apiToken, pipelineId = null) {
  if (stageNameOrId == null || stageNameOrId === '') return null;
  if (typeof stageNameOrId === 'number' || /^\d+$/.test(String(stageNameOrId))) return Number(stageNameOrId);
  const data = await pdGet('/stages', apiToken);
  const found = (data?.data || []).find((stage) => {
    if (norm(stage.name) !== norm(stageNameOrId)) return false;
    return !pipelineId || Number(stage.pipeline_id) === Number(pipelineId);
  });
  return found?.id || null;
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Retourne le mapping complet des champs biens (statique + custom).
 * @returns {{ static: Record<string, string>, custom: Record<string, string> }}
 */
async function getBienKeys(apiToken) {
  const fieldMap = apiToken ? await getDealFieldsMap(apiToken).catch(() => ({})) : {};
  const findKey = (name) => Object.entries(fieldMap).find(([, label]) => norm(label) === norm(name))?.[0];
  return {
    ...BIEN_KEYS_CUSTOM,
    ...LEGACY_BIEN_KEYS,
    surface: findKey('Surface') || BIEN_KEYS_CUSTOM.surface,
    nb_pieces: findKey('Nombre de pieces') || findKey('Pieces') || BIEN_KEYS_CUSTOM.nb_pieces,
    type_bien: findKey('Type de bien') || findKey('Type') || BIEN_KEYS_CUSTOM.type_bien,
    etage: findKey('Etage') || BIEN_KEYS_CUSTOM.etage,
    ascenseur: findKey('Ascenseur'),
    balcon: findKey('Balcon'),
    terrasse: findKey('Terrasse'),
    jardin: findKey('Jardin'),
    parking: findKey('Parking'),
    cave: findKey('Cave'),
    photo_1: findKey('Photo 1') || findKey('Photo principale') || BIEN_KEYS_CUSTOM.photo_url,
    photo_2: findKey('Photo 2'),
    photo_3: findKey('Photo 3'),
    photo_4: findKey('Photo 4'),
    autre_photo: findKey('Autre photo'),
    description: findKey('Description') || findKey('Descriptif'),
    charge_annuelle: findKey('Charge annuelle') || findKey('Charges annuelles'),
    loyer_post_revision: findKey('Loyer post-revision') || findKey('Loyer post revision'),
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
  getDealFieldsMap,
  getBienKeys,
  getAcqKeys,
  invalidateBienKeysCache,
  extractField,
  norm,
  resolveSet,
  resolveEnum,
  findPipelineId,
  findStageId,
  OCC_LABELS,
  OCC_MAP_SIMPLE,
  ACQ_KEYS,
  TVA_LABELS,
  MODALITE_LABELS,
  IMPUT_TF_LABELS,
  // Exports individuels pour les tests
  BIEN_KEYS_STATIC,
  BIEN_KEYS_CUSTOM,
  ACQ_KEYS_STATIC,
  ACQ_KEYS_CUSTOM,
};
