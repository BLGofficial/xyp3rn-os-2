-- Audit 2026-10-10: knowledge_versions, research_evidence and research_findings were append-only only because no
-- role held UPDATE/DELETE. Add the row trigger every other append-only table has, so the owner role cannot rewrite
-- them either. Reuses xyp_vault_immutable(); no code path updates or deletes these tables.
create or replace trigger trg_knowledge_versions_immutable before update or delete on public.knowledge_versions
  for each row execute function public.xyp_vault_immutable();
create or replace trigger trg_research_evidence_immutable before update or delete on public.research_evidence
  for each row execute function public.xyp_vault_immutable();
create or replace trigger trg_research_findings_immutable before update or delete on public.research_findings
  for each row execute function public.xyp_vault_immutable();
