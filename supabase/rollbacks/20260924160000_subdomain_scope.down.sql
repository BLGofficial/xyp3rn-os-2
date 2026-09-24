-- Rollback for 20260924160000_subdomain_scope.sql. Idempotent.
do $$ begin
  if to_regnamespace('extensions') is not null and to_regtype('extensions.vector') is not null then
    drop function if exists public.xyp_match_knowledge_in_modules(extensions.vector, integer, text[]);
  end if;
end $$;
