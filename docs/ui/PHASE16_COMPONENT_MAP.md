# Mercury component map

`MercuryShell` owns URL view/domain/node state and one canonical projection response. `TopCommandBar` renders application version, navigation, search and authenticated identity. `LeftSystemRail` selects projections and filters. `GraphViewport` owns `MercurySystemGraph`, deterministic layout, overflow groups and `MusicSystemPanel`. `RightIntelligenceRail` displays metrics with query provenance, bounded events and an unconfigured geographic map. `InfrastructureRail` opens the same entity inspector for configuration-backed infrastructure. `EntityInspector` renders allowlisted source fields and authorized approval actions.

Graph and lists consume the same nodes; search never creates another dataset. Server-side projection owns RBAC filtering. Browser polling is bounded and pauses when hidden. A single node telemetry change must not rebuild graph geometry.
