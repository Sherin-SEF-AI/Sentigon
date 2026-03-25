"""Autonomous investigation agent — runs multi-step investigations."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models import InvestigationRun, Event, Alert, Case
from backend.services.vector_store import vector_store
from backend.services.gemini_forensics import gemini_forensics

logger = logging.getLogger(__name__)


class InvestigationAgent:
    """Runs autonomous multi-step investigations on a case.

    The investigation pipeline follows five sequential phases:
    1. Semantic search to gather related events.
    2. Deep frame analysis with Gemini Pro on key evidence.
    3. Cross-camera correlation to track subjects.
    4. Findings synthesis and risk assessment.
    5. Persist results to the investigation_runs table.
    """

    # ------------------------------------------------------------------ #
    #  Public entry point                                                 #
    # ------------------------------------------------------------------ #

    async def run_investigation(
        self,
        case_id: str,
        query: str,
        agent_type: str = "general",
    ) -> Dict[str, Any]:
        """Execute an autonomous multi-step investigation for a case.

        Parameters
        ----------
        case_id : str
            UUID of the parent case.
        query : str
            Natural-language description of what to investigate.
        agent_type : str
            Label stored on the investigation run (e.g. "general",
            "forensic", "timeline").

        Returns
        -------
        dict
            Full investigation result including steps, findings, and
            the investigation run id.
        """
        run_id: Optional[uuid.UUID] = None
        steps: List[Dict[str, Any]] = []

        try:
            # Create the investigation run record
            run_id = await self._create_run(case_id, agent_type, query)
            logger.info(
                "Investigation started: run=%s case=%s query='%s'",
                run_id, case_id, query[:80],
            )

            # ── Step 1: Gather related events via semantic search ──
            related_events = await self._step_gather_events(query, steps)

            # ── Step 2: Deep-analyse key frames with Gemini Pro ────
            frame_analyses = await self._step_analyse_frames(
                related_events, query, steps,
            )

            # ── Step 3: Cross-camera correlation ───────────────────
            correlation = await self._step_correlate_cameras(
                related_events, steps,
            )

            # ── Step 4: Synthesise findings ────────────────────────
            findings = await self._step_generate_findings(
                related_events, frame_analyses, correlation, query, steps,
            )

            # ── Step 5: Persist to DB ──────────────────────────────
            await self._finalise_run(
                run_id, steps, findings, status="completed",
            )

            logger.info("Investigation completed: run=%s", run_id)
            return {
                "investigation_id": str(run_id),
                "status": "completed",
                "steps": steps,
                "findings": findings,
            }

        except Exception as exc:
            logger.exception("Investigation failed: run=%s", run_id)
            error_step = self._make_step(
                "error", {"error": str(exc)},
            )
            steps.append(error_step)

            if run_id is not None:
                await self._finalise_run(
                    run_id, steps,
                    findings={"error": str(exc)},
                    status="failed",
                )

            return {
                "investigation_id": str(run_id) if run_id else None,
                "status": "failed",
                "steps": steps,
                "findings": {"error": str(exc)},
            }

    # ------------------------------------------------------------------ #
    #  Pipeline steps                                                     #
    # ------------------------------------------------------------------ #

    async def _step_gather_events(
        self,
        query: str,
        steps: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Step 1 — semantic search in vector store."""
        logger.info("Step 1: Gathering related events for query")
        results = vector_store.search(query, top_k=20)

        # Enrich with DB records where possible
        enriched: List[Dict[str, Any]] = []
        event_ids = [r["event_id"] for r in results if r.get("event_id")]

        if event_ids:
            try:
                async with async_session() as session:
                    stmt = select(Event).where(
                        Event.id.in_(
                            [uuid.UUID(eid) for eid in event_ids if eid]
                        )
                    )
                    db_result = await session.execute(stmt)
                    db_events = {
                        str(e.id): e for e in db_result.scalars().all()
                    }

                    for r in results:
                        eid = r.get("event_id", "")
                        db_ev = db_events.get(eid)
                        enriched.append({
                            **r,
                            "event_type": (
                                db_ev.event_type if db_ev else r.get("event_type", "")
                            ),
                            "camera_id": (
                                str(db_ev.camera_id) if db_ev else r.get("camera_id", "")
                            ),
                            "severity": (
                                db_ev.severity.value if db_ev else ""
                            ),
                            "timestamp": (
                                db_ev.timestamp.isoformat()
                                if db_ev and db_ev.timestamp
                                else r.get("timestamp", "")
                            ),
                            "description": (
                                db_ev.description
                                if db_ev and db_ev.description
                                else r.get("description", "")
                            ),
                        })
            except Exception as exc:
                logger.warning("DB enrichment failed, using raw results: %s", exc)
                enriched = results
        else:
            enriched = results

        steps.append(
            self._make_step(
                "gather_events",
                {
                    "query": query,
                    "events_found": len(enriched),
                    "top_scores": [
                        e.get("score") for e in enriched[:5]
                    ],
                },
            )
        )
        return enriched

    async def _step_analyse_frames(
        self,
        events: List[Dict[str, Any]],
        query: str,
        steps: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Step 2 — deep Gemini Pro analysis of available frames."""
        logger.info("Step 2: Analysing key frames with Gemini Pro")
        analyses: List[Dict[str, Any]] = []

        # Attempt frame-level analysis for events that have frame data
        # In a production system the frame bytes would be fetched from
        # object storage; here we ask Gemini to build a narrative from
        # event metadata when actual frames are unavailable.
        event_summaries = [
            {
                "event_id": e.get("event_id", ""),
                "description": e.get("description", ""),
                "event_type": e.get("event_type", ""),
                "camera_id": e.get("camera_id", ""),
                "timestamp": e.get("timestamp", ""),
            }
            for e in events[:10]  # cap to keep latency reasonable
        ]

        if event_summaries:
            try:
                summary = await gemini_forensics.generate_incident_summary(
                    event_summaries, query=query,
                )
                analyses.append(summary)
            except Exception as exc:
                logger.warning("Gemini frame analysis failed: %s", exc)
                analyses.append({"error": str(exc)})

        steps.append(
            self._make_step(
                "analyse_frames",
                {
                    "frames_analysed": len(event_summaries),
                    "analysis_count": len(analyses),
                },
            )
        )
        return analyses

    async def _step_correlate_cameras(
        self,
        events: List[Dict[str, Any]],
        steps: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Step 3 — find cross-camera appearances via vector similarity."""
        logger.info("Step 3: Cross-camera correlation")
        camera_groups: Dict[str, List[Dict[str, Any]]] = {}
        for ev in events:
            cam = ev.get("camera_id", "unknown")
            camera_groups.setdefault(cam, []).append(ev)

        correlation: Dict[str, Any] = {
            "cameras_involved": list(camera_groups.keys()),
            "events_per_camera": {
                cam: len(evts) for cam, evts in camera_groups.items()
            },
            "cross_camera_matches": [],
        }

        # For each event look for similar events on *other* cameras
        seen_pairs: set = set()
        for ev in events[:10]:
            eid = ev.get("event_id", "")
            if not eid:
                continue
            try:
                similar = vector_store.search_similar_events(eid, top_k=5)
                for sim in similar:
                    sim_cam = sim.get("metadata", {}).get("camera_id", "")
                    if sim_cam and sim_cam != ev.get("camera_id"):
                        pair_key = tuple(sorted([eid, sim.get("event_id", "")]))
                        if pair_key not in seen_pairs:
                            seen_pairs.add(pair_key)
                            correlation["cross_camera_matches"].append({
                                "event_a": eid,
                                "camera_a": ev.get("camera_id"),
                                "event_b": sim.get("event_id"),
                                "camera_b": sim_cam,
                                "similarity": sim.get("score", 0),
                            })
            except Exception as exc:
                logger.debug("Similarity lookup skipped for %s: %s", eid, exc)

        steps.append(
            self._make_step(
                "correlate_cameras",
                {
                    "cameras": len(camera_groups),
                    "cross_matches": len(correlation["cross_camera_matches"]),
                },
            )
        )
        return correlation

    async def _step_generate_findings(
        self,
        events: List[Dict[str, Any]],
        analyses: List[Dict[str, Any]],
        correlation: Dict[str, Any],
        query: str,
        steps: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Step 4 — synthesise all evidence into structured findings."""
        logger.info("Step 4: Generating findings")

        # Build a combined evidence bundle for Gemini
        evidence_bundle = [
            {
                "event_id": e.get("event_id"),
                "description": e.get("description"),
                "event_type": e.get("event_type"),
                "camera_id": e.get("camera_id"),
                "timestamp": e.get("timestamp"),
                "score": e.get("score"),
            }
            for e in events[:15]
        ]

        try:
            findings = await gemini_forensics.generate_incident_summary(
                evidence_bundle, query=query,
            )
            # Attach correlation data
            findings["correlation"] = correlation
            findings["evidence_count"] = len(events)
        except Exception as exc:
            logger.warning("Findings generation via Gemini failed: %s", exc)
            findings = {
                "incident_summary": (
                    f"Automated investigation for: {query}. "
                    f"Found {len(events)} related events across "
                    f"{len(correlation.get('cameras_involved', []))} cameras."
                ),
                "key_findings": [
                    e.get("description", "") for e in events[:5]
                ],
                "correlation": correlation,
                "evidence_count": len(events),
            }

        steps.append(
            self._make_step(
                "generate_findings",
                {
                    "summary_length": len(
                        findings.get("incident_summary", "")
                    ),
                    "key_findings_count": len(
                        findings.get("key_findings", [])
                    ),
                },
            )
        )
        return findings

    # ------------------------------------------------------------------ #
    #  Database helpers                                                   #
    # ------------------------------------------------------------------ #

    async def _create_run(
        self,
        case_id: str,
        agent_type: str,
        query: str,
    ) -> uuid.UUID:
        """Insert a new investigation_runs row with status='running'."""
        async with async_session() as session:
            run = InvestigationRun(
                case_id=uuid.UUID(case_id),
                agent_type=agent_type,
                status="running",
                input_params={"query": query},
                steps=[],
                started_at=datetime.now(timezone.utc),
            )
            session.add(run)
            await session.commit()
            await session.refresh(run)
            return run.id

    async def _finalise_run(
        self,
        run_id: uuid.UUID,
        steps: List[Dict[str, Any]],
        findings: Dict[str, Any],
        status: str = "completed",
    ) -> None:
        """Update the investigation run with results."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(InvestigationRun).where(
                        InvestigationRun.id == run_id,
                    )
                )
                run = result.scalar_one_or_none()
                if run is None:
                    logger.error("Investigation run not found: %s", run_id)
                    return

                run.status = status
                run.steps = steps
                run.findings = findings
                run.summary = findings.get("incident_summary", "")
                run.completed_at = datetime.now(timezone.utc)
                await session.commit()
        except Exception as exc:
            logger.error("Failed to finalise investigation run %s: %s", run_id, exc)

    # ------------------------------------------------------------------ #
    #  Utilities                                                          #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _make_step(action: str, result: Any) -> Dict[str, Any]:
        return {
            "action": action,
            "result": result,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


# Singleton
investigation_agent = InvestigationAgent()
