# Reference-to-runtime mapping

| Reference element | Source / query | Empty state | Action |
|---|---|---|---|
| Identity / role | governance session, user and role tables | Sign in | Session login/logout |
| Version | package.json.version | None; file required | Hub inspector |
| Domain / component | taxonomy + Agent Registry components, checked source paths | No registered entities | Focus/list/inspect |
| Agents online | pending agent_runs matched to registered agents | Zero running; not a heartbeat count | Agents |
| Workflows active | workflow_runs WHERE status=running | Zero / unavailable | Workflows |
| Knowledge nodes | current canonical_prompts + current modules | Zero / unavailable | Knowledge |
| Research tasks | research_projects WHERE status=open | Zero / unavailable | Research |
| Records projects | releases outside released/cancelled | Zero / unavailable | Records |
| API connections | existing provider adapters with configured key presence only | Unconfigured; health unknown | Provider inspector |
| Uptime | No uptime series is registered | Not measured | Resource monitor |
| Live activity | agent_runs, workflow_runs, knowledge_versions, research_runs, audit_log | No recorded activity | Source inspector |
| Global reach | No analytics integration | No analytics source configured | Informational panel |
| APIs / connectors | core/llm/providers.ts + configuration presence | Unconfigured | Provider list |
| Data pipeline | existing ingestion, context and research services | Source-backed configuration | Inspector |
| Security | Phase 15 RBAC + audit/approval query | Unauthorized fields omitted | Governance |
| Infrastructure | reachable local PostgreSQL + server runtime | Unavailable / unknown | Resources |
| Global deployment | Explicit deployment configuration only | No deployment source configured | Inspector |

Every operational metric includes source, query and generatedAt. List limits are explicit and do not stand in for total counts. Audit events expose safe summaries; raw input/output, credentials and private contexts never enter the projection.
