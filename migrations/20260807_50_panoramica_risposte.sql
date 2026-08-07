-- Panoramica: benchmark sul TASSO DI RISPOSTA (risposte ÷ lead reali).
-- v_panoramica_centro non aveva le risposte: il dato sta in agg_mkt_ad_giorno
-- (per annuncio), qui si aggrega per centro/giorno e si appende in coda alla
-- vista. Verificato che copre TUTTI i lead reali, non solo quelli da annuncio:
-- su 60 giorni sum(agg_mkt_ad_giorno.lead) = sum(agg_mkt_centro_giorno.lead_reali) = 11.363.
-- Il LEFT JOIN aggiunge solo una colonna: nessuna riga nuova, quindi lo scoping
-- per centro resta quello di prima.
-- ⚠️ Corpo ripreso da pg_get_viewdef, non da una migration vecchia (vedi CLAUDE.md).
create or replace view public.v_panoramica_centro as
 WITH covered AS (
         SELECT m.ad_account_id
           FROM fb_account_map m
          WHERE m.centro_id IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM fb_insights_ad f
                  WHERE f.ad_account_id = m.ad_account_id))
        ), escluse AS (
         SELECT fb_campaign_class.campaign_id
           FROM fb_campaign_class
          WHERE fb_campaign_class.is_sv = false
        ), fb_centro AS (
         SELECT COALESCE(a.centro_id, m.centro_id) AS centro_id,
            f.giorno,
            sum(COALESCE(f.spend, 0::numeric)) AS spesa,
            sum(COALESCE(f.impressions, 0::bigint)) AS impression,
            sum(COALESCE(f.fb_leads, 0)) AS lead_fb
           FROM fb_insights_ad f
             LEFT JOIN fb_account_map m ON m.ad_account_id = f.ad_account_id
             LEFT JOIN fb_campaign_attr_giorno a ON a.campaign_id = f.campaign_id AND a.giorno = f.giorno
          WHERE (f.campaign_id IS NULL OR NOT (f.campaign_id IN ( SELECT escluse.campaign_id
                   FROM escluse))) AND COALESCE(a.centro_id, m.centro_id) IS NOT NULL
          GROUP BY (COALESCE(a.centro_id, m.centro_id)), f.giorno
        ), perf_fallback AS (
         SELECT p.centro_id,
            p.giorno,
            sum(COALESCE(p.spesa_ads, 0::numeric)) AS spesa,
            sum(COALESCE(p.impression, 0::bigint)) AS impression,
            sum(COALESCE(p.lead_fb, 0)) AS lead_fb
           FROM perf_giorno p
             LEFT JOIN centri c_1 ON c_1.notion_id = p.centro_id
          WHERE (c_1.fb_ad_account_id IS NULL OR NOT (c_1.fb_ad_account_id IN ( SELECT covered.ad_account_id
                   FROM covered))) AND NOT (EXISTS ( SELECT 1
                   FROM fb_centro fc
                  WHERE fc.centro_id = p.centro_id AND fc.giorno = p.giorno))
          GROUP BY p.centro_id, p.giorno
        ), merged AS (
         SELECT u.centro_id,
            u.giorno,
            sum(u.spesa) AS spesa,
            sum(u.impression) AS impression,
            sum(u.lead_fb) AS lead_fb
           FROM ( SELECT fb_centro.centro_id,
                    fb_centro.giorno,
                    fb_centro.spesa,
                    fb_centro.impression,
                    fb_centro.lead_fb
                   FROM fb_centro
                UNION ALL
                 SELECT perf_fallback.centro_id,
                    perf_fallback.giorno,
                    perf_fallback.spesa,
                    perf_fallback.impression,
                    perf_fallback.lead_fb
                   FROM perf_fallback) u
          GROUP BY u.centro_id, u.giorno
        ), risp AS (
         SELECT a.centro_id,
            a.giorno,
            sum(COALESCE(a.risposte, 0::bigint)) AS risposte
           FROM agg_mkt_ad_giorno a
          GROUP BY a.centro_id, a.giorno
        )
 SELECT centro_id,
    giorno,
    c.nome AS centro,
    c.consulente,
    c.stato_attivita,
    COALESCE(s.spesa, 0::numeric) AS spesa,
    COALESCE(s.impression, 0::numeric) AS impression,
    COALESCE(s.lead_fb, 0::numeric)::bigint AS lead_fb,
    COALESCE(w.lead_reali, 0::bigint) AS lead_reali,
    COALESCE(w.appuntamenti_presi, 0::bigint) AS appuntamenti,
    COALESCE(w.presenze, 0::bigint) AS presenze,
    COALESCE(w.no_show, 0::bigint) AS non_presentati,
    COALESCE(w.pacchetti, 0::bigint) AS pacchetti,
    COALESCE(w.ricavo, 0::numeric) AS ricavo,
    COALESCE(w.potenziale, 0::numeric) AS potenziale,
    COALESCE(w.lead_reali, 0::bigint) AS wh_lead_reali,
    COALESCE(w.appuntamenti_presi, 0::bigint) AS wh_appuntamenti_presi,
    COALESCE(w.appuntamenti_svolti, 0::bigint) AS wh_appuntamenti_svolti,
    COALESCE(w.presenze, 0::bigint) AS wh_presenze,
    COALESCE(w.no_show, 0::bigint) AS wh_no_show,
    COALESCE(w.pacchetti, 0::bigint) AS wh_pacchetti,
    COALESCE(w.ricavo, 0::numeric) AS wh_ricavo,
    COALESCE(w.potenziale, 0::numeric) AS wh_potenziale,
    COALESCE(r.risposte, 0::bigint) AS risposte
   FROM merged s
     FULL JOIN agg_mkt_centro_giorno w USING (centro_id, giorno)
     LEFT JOIN centri c ON c.notion_id = centro_id
     LEFT JOIN risp r USING (centro_id, giorno);
