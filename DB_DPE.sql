-- =============================================================================
-- Migration : Ajout du Diagnostic de Performance Énergétique (DPE)
-- Version   : 2026_001_add_dpe
-- Auteur    : Le Flutch
-- =============================================================================
-- Stratégie :
--   - Colonne nullable au départ (rétrocompatible avec les biens existants)
--   - JSONB pour les critères acquéreurs (tableau ordonné de lettres A-G)
--   - Index partiel sur biens pour éviter de scanner les NULL
--   - Fonction PL/pgSQL pour valider les tableaux DPE côté DB
-- =============================================================================

BEGIN;

-- ─── 1. Table biens — ajout dpe_classe ───────────────────────────────────────

ALTER TABLE biens
  ADD COLUMN IF NOT EXISTS dpe_classe CHAR(1)
    CHECK (dpe_classe IN ('A','B','C','D','E','F','G'));

COMMENT ON COLUMN biens.dpe_classe IS
  'Classe DPE du bien immobilier (A=meilleure, G=pire). NULL si non renseigné.';

-- Index classique (non partiel pour inclure les NULL dans les tris)
CREATE INDEX IF NOT EXISTS idx_biens_dpe_classe
  ON biens (dpe_classe)
  WHERE dpe_classe IS NOT NULL;

-- ─── 2. Table acquereur_criteria — ajout dpe_classes ─────────────────────────

-- Si la table acquereur_criteria existe déjà (critères de recherche acquéreur)
ALTER TABLE acquereur_criteria
  ADD COLUMN IF NOT EXISTS dpe_classes JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN acquereur_criteria.dpe_classes IS
  'Classes DPE acceptées par l''acquéreur. Ex: ["A","B","C"]. Tableau vide = pas de filtre.';

-- Contrainte : vérifier que chaque élément du tableau est une lettre A-G valide
ALTER TABLE acquereur_criteria
  ADD CONSTRAINT chk_dpe_classes_valid
    CHECK (
      dpe_classes IS NULL
      OR (
        jsonb_typeof(dpe_classes) = 'array'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(dpe_classes) AS elem
          WHERE elem NOT IN ('A','B','C','D','E','F','G')
        )
      )
    );

-- Index GIN pour recherches rapides (ex: WHERE dpe_classes @> '["A"]')
CREATE INDEX IF NOT EXISTS idx_acquereur_criteria_dpe_gin
  ON acquereur_criteria USING GIN (dpe_classes);

-- ─── 3. Fonction helper : normalisation lettre DPE ───────────────────────────

CREATE OR REPLACE FUNCTION normalize_dpe_classe(raw TEXT)
RETURNS CHAR(1) AS $$
DECLARE
  upper_raw CHAR(1);
BEGIN
  upper_raw := UPPER(TRIM(raw));
  IF upper_raw IN ('A','B','C','D','E','F','G') THEN
    RETURN upper_raw;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION normalize_dpe_classe IS
  'Normalise une valeur DPE brute en lettre A-G, NULL si invalide.';

-- ─── 4. Mise à jour du schéma action_logs (si nécessaire) ────────────────────
-- S'assurer que les champs DPE apparaissent dans les exports de stats

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_logs' AND column_name = 'dpe_classe'
  ) THEN
    -- Pas de colonne dédiée : le champ sera dans metadata JSONB
    -- Rien à faire
    RAISE NOTICE 'action_logs: DPE sera logué dans metadata JSONB';
  END IF;
END $$;

-- ─── 5. Vue matching enrichie (optionnel — pour debug / reporting) ────────────

CREATE OR REPLACE VIEW v_matching_dpe AS
SELECT
  b.id               AS bien_id,
  b.titre,
  b.dpe_classe,
  a.id               AS acquereur_id,
  a.nom              AS acquereur_nom,
  ac.dpe_classes     AS dpe_acceptees,
  -- Compatibilité DPE : TRUE si acquéreur accepte ce DPE
  CASE
    WHEN ac.dpe_classes IS NULL OR ac.dpe_classes = '[]'::jsonb THEN TRUE
    WHEN b.dpe_classe IS NULL                                    THEN TRUE   -- bien sans DPE → non filtré
    ELSE ac.dpe_classes ? b.dpe_classe                          -- opérateur ? = contient l'élément
  END AS dpe_compatible
FROM biens b
CROSS JOIN acquereurs a
LEFT JOIN acquereur_criteria ac ON ac.acquereur_id = a.id
WHERE b.statut = 'actif'
  AND a.actif = TRUE;

COMMENT ON VIEW v_matching_dpe IS
  'Vue de diagnostic : compatibilité DPE entre biens et acquéreurs.';

COMMIT;

-- =============================================================================
-- Rollback (à exécuter manuellement en cas de problème)
-- =============================================================================
-- BEGIN;
-- DROP VIEW IF EXISTS v_matching_dpe;
-- DROP FUNCTION IF EXISTS normalize_dpe_classe(TEXT);
-- ALTER TABLE acquereur_criteria DROP CONSTRAINT IF EXISTS chk_dpe_classes_valid;
-- ALTER TABLE acquereur_criteria DROP COLUMN IF EXISTS dpe_classes;
-- DROP INDEX IF EXISTS idx_acquereur_criteria_dpe_gin;
-- ALTER TABLE biens DROP COLUMN IF EXISTS dpe_classe;
-- DROP INDEX IF EXISTS idx_biens_dpe_classe;
-- COMMIT;