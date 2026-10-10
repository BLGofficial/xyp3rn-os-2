-- Rollback for 20261011100000_core_immutability.sql. Idempotent. No CASCADE.
drop trigger if exists trg_knowledge_versions_immutable on public.knowledge_versions;
drop trigger if exists trg_research_evidence_immutable on public.research_evidence;
drop trigger if exists trg_research_findings_immutable on public.research_findings;
