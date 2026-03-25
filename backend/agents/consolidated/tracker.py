"""Tracker Agent — Cross-camera entity tracking, re-identification, path reconstruction, and companion detection.

Consolidates: Correlator, ReID Agent, Ghost Tracer, Companion Discovery.
Subscribes to perception events and correlates entities across cameras,
reconstructs movement paths, detects co-moving groups, and identifies
suspicious cross-camera patterns.
"""
from __future__ import annotations

import json, logging, math, time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS, CH_CORRELATION

logger = logging.getLogger(__name__)

_COMPANION_PROXIMITY_PX = 200
_COMPANION_MIN_COOCCURRENCE = 2
_COMPANION_WINDOW_S = 30.0
_PATH_TTL = 600
_ENTITY_TTL = 300
_MAX_ENTITIES_PER_CYCLE = 8
_PATTERN_CHECK_EVERY_N = 6

_PATTERN_PROMPT = """\
You are a cross-camera security analyst. Analyze the following entity \
tracking data and movement patterns for suspicious activity.

**Tracked entities:** {tracking_summary}
**Companion groups:** {companion_summary}
**Site context:** {site_context}

Detect: 1) LOOPING — same camera 3+ times  2) RESTRICTED PROBING — sensitive zones \
3) COORDINATED MOVEMENT — companion groups in restricted areas  4) COUNTER-SURVEILLANCE \
— lingering near cameras/exits  5) TEMPORAL CLUSTERING — convergence on one area

Respond JSON: {{"patterns": [{{"type": "<type>", "severity": "<low|medium|high|critical>", \
"entities": ["<id>"], "cameras": ["<cam>"], "description": "<obs>", "confidence": <0-1>}}], \
"summary": "<assessment>"}}
"""


class TrackerAgent(BaseAgent):
    """Consolidated cross-camera entity tracker, re-identifier, path
    reconstructor, and companion detector."""

    def __init__(self) -> None:
        super().__init__(
            name="tracker",
            role="Cross-Camera Entity Tracker & Correlator",
            description=(
                "Correlates entities across cameras, tracks movement paths, "
                "detects companions, and identifies suspicious cross-camera "
                "patterns using appearance descriptors and temporal analysis."
            ),
            tier="reasoning",
            model_name="gemma3:4b",
            tool_names=[
                "get_current_detections", "get_all_cameras_status", "get_site_context",
                "get_alert_history", "get_event_history", "semantic_search",
                "store_observation", "create_event",
            ],
            subscriptions=[CH_PERCEPTIONS, CH_CORTEX],
            cycle_interval=20.0,
            token_budget_per_cycle=20000,
        )
        self._tracked: dict[str, list[dict]] = {}          # entity_id -> sighting records
        self._paths: dict[str, list[tuple]] = {}            # entity_id -> [(cam, ts, zone)]
        self._path_ts: dict[str, float] = {}                # entity_id -> last update epoch
        self._cooccur: dict[str, int] = defaultdict(int)    # "eidA||eidB" -> count
        self._companions: list[dict] = []
        self._corr_seq = 1

    # ── Core reasoning loop ───────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        inbox, cycle, now = context.get("inbox_messages", []), context.get("cycle", 0), time.time()
        sightings = self._extract_sightings(inbox)
        if not sightings:
            self._prune(now)
            return {"status": "idle", "tracked": len(self._tracked)}
        logger.info("Tracker: %d sightings, cycle %d, tracking %d", len(sightings), cycle, len(self._tracked))

        # 2 — Cross-camera correlation
        new_corrs = 0
        for s in sightings[:_MAX_ENTITIES_PER_CYCLE]:
            cid = self._correlate(s, now)
            if cid:
                new_corrs += 1
                await self.send_message(CH_CORRELATION, {
                    "type": "entity_tracked", "correlation_id": cid, "entity_id": s["entity_id"],
                    "camera_id": s["camera_id"], "track_id": s.get("track_id"),
                    "description": s.get("description", ""),
                    "cameras_seen": len(self._tracked.get(s["entity_id"], [])),
                    "timestamp": datetime.now(timezone.utc).isoformat()})

        # 3 — Path anomaly detection (ghost tracing)
        anomalies = self._path_anomalies()
        for a in anomalies:
            await self.send_message(CH_CORRELATION, {"type": "path_anomaly", **a,
                                    "timestamp": datetime.now(timezone.utc).isoformat()})
            await self.learn(f"Path anomaly: {a['entity_id']} — {a['pattern']} "
                             f"across {a['camera_count']} cameras", category="path_anomaly")

        # 4 — Companion detection
        new_comp = self._detect_companions(sightings)
        for g in new_comp:
            await self.send_message(CH_CORRELATION, {"type": "companion_group", **g,
                                    "timestamp": datetime.now(timezone.utc).isoformat()})
            await self.log_action("companion_discovered", {"entities": g["entities"],
                "camera_id": g["camera_id"], "cooccurrence": g["cooccurrence_count"],
                "decision": f"Companion group: {g['entities']} (co-seen {g['cooccurrence_count']}x)"})

        # 5 — Periodic LLM pattern analysis
        pat = None
        if cycle > 0 and cycle % _PATTERN_CHECK_EVERY_N == 0 and self._tracked:
            pat = await self._llm_pattern_analysis()

        # 6 — Temporal cluster detection
        clusters = self._temporal_clusters(sightings)
        for cl in clusters:
            await self.send_message(CH_CORRELATION, {"type": "suspicious_pattern",
                "subtype": "temporal_cluster", **cl, "timestamp": datetime.now(timezone.utc).isoformat()})

        self._prune(now)
        await self._sync_memory()
        return {"status": "processed", "sightings": len(sightings), "correlations": new_corrs,
                "path_anomalies": len(anomalies), "companions": len(new_comp),
                "clusters": len(clusters), "tracked": len(self._tracked), "pattern": bool(pat)}

    # ── 1  Sighting extraction ────────────────────────────────────────

    def _extract_sightings(self, inbox: list[dict]) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()
        ok_types = {"perception", "detection", "scene_analysis", "perception_event", "person_detected"}
        ok_cls = {"person", "car", "truck", "motorcycle", "bicycle"}
        for msg in inbox:
            if msg.get("type", "") not in ok_types or not msg.get("camera_id"):
                continue
            cam = msg["camera_id"]
            for d in msg.get("detections", []):
                cls = d.get("class", "")
                if cls not in ok_cls or d.get("confidence", 0) < 0.45:
                    continue
                tid = d.get("track_id")
                key = f"{cam}:{tid or id(d)}"
                if key in seen:
                    continue
                seen.add(key)
                eid = f"{cam}:t{tid}" if tid is not None else f"{cam}:{cls[:12]}:{d.get('confidence',0):.2f}"
                parts = [cls]
                if tid: parts.append(f"track#{tid}")
                sc = msg.get("scene_description", "")
                if sc: parts.append(f"in: {sc[:80]}")
                if d.get("dwell_time", 0) > 30: parts.append(f"dwelling {d['dwell_time']:.0f}s")
                out.append({"entity_id": eid, "camera_id": cam, "track_id": tid, "class": cls,
                    "confidence": d.get("confidence", 0), "description": " ".join(parts),
                    "zone": d.get("zone") or msg.get("zone"),
                    "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat()),
                    "dwell_time": d.get("dwell_time", 0), "bbox": d.get("bbox")})
        return out

    # ── 2  Cross-camera correlation ───────────────────────────────────

    def _correlate(self, s: dict, now: float) -> str | None:
        eid, cam = s["entity_id"], s["camera_id"]
        rec = {"camera_id": cam, "timestamp": s["timestamp"], "description": s.get("description", ""),
               "track_id": s.get("track_id"), "zone": s.get("zone")}
        matched = self._find_match(s)
        tgt = matched if matched and matched != eid else eid
        self._tracked.setdefault(tgt, []).append(rec)
        self._tracked[tgt] = self._tracked[tgt][-30:]
        self._paths.setdefault(tgt, []).append((cam, s["timestamp"], s.get("zone")))
        self._path_ts[tgt] = now
        cams = {r["camera_id"] for r in self._tracked[tgt]}
        if len(cams) >= 2 or (matched and matched != eid):
            cid = f"COR-{self._corr_seq:06d}"; self._corr_seq += 1; return cid
        return None

    def _find_match(self, s: dict) -> str | None:
        words = set(s.get("description", "").lower().split())
        cam, best, best_sc = s["camera_id"], None, 0.0
        for eid, recs in self._tracked.items():
            if {r["camera_id"] for r in recs} == {cam}: continue
            other = set(recs[-1].get("description", "").lower().split()) if recs else set()
            if not other: continue
            sc = len(words & other) / max(len(words | other), 1)
            if sc > 0.4 and sc > best_sc: best, best_sc = eid, sc
        return best

    # ── 3  Path anomaly detection ─────────────────────────────────────

    def _path_anomalies(self) -> list[dict]:
        out: list[dict] = []
        restricted_kw = {"restricted", "secure", "server", "vault", "executive"}
        for eid, path in self._paths.items():
            if len(path) < 2: continue
            cams = [p[0] for p in path]; unique = set(cams); zones = [p[2] for p in path if p[2]]
            counts = Counter(cams)
            loops = [c for c, n in counts.items() if n >= 3]
            if loops:
                out.append({"entity_id": eid, "pattern": "looping", "cameras": loops,
                    "camera_count": len(unique), "visit_counts": dict(counts),
                    "severity": "medium" if len(loops) == 1 else "high"})
            if len(unique) >= 4:
                out.append({"entity_id": eid, "pattern": "wide_coverage", "cameras": list(unique),
                    "camera_count": len(unique), "path_summary": " -> ".join(cams[-8:]), "severity": "medium"})
            rz = [z for z in zones if any(k in z.lower() for k in restricted_kw)]
            if rz:
                out.append({"entity_id": eid, "pattern": "restricted_area_visit", "cameras": list(unique),
                    "camera_count": len(unique), "zones": rz, "severity": "high"})
        return out

    # ── 4  Companion detection ────────────────────────────────────────

    def _detect_companions(self, sightings: list[dict]) -> list[dict]:
        by_cam: dict[str, list[dict]] = defaultdict(list)
        for s in sightings: by_cam[s["camera_id"]].append(s)
        new: list[dict] = []
        for cam, items in by_cam.items():
            if len(items) < 2: continue
            for i in range(len(items)):
                for j in range(i + 1, len(items)):
                    a, b = items[i], items[j]
                    ta, tb = self._ts(a.get("timestamp","")), self._ts(b.get("timestamp",""))
                    if ta and tb and abs((ta - tb).total_seconds()) > _COMPANION_WINDOW_S: continue
                    if a.get("bbox") and b.get("bbox") and self._bdist(a["bbox"], b["bbox"]) > _COMPANION_PROXIMITY_PX: continue
                    pk = "||".join(sorted([a["entity_id"], b["entity_id"]]))
                    self._cooccur[pk] += 1
                    if self._cooccur[pk] == _COMPANION_MIN_COOCCURRENCE:
                        g = {"entities": sorted([a["entity_id"], b["entity_id"]]), "camera_id": cam,
                             "cooccurrence_count": self._cooccur[pk], "zone": a.get("zone") or b.get("zone")}
                        self._companions.append(g); new.append(g)
        return new

    @staticmethod
    def _bdist(a: list, b: list) -> float:
        return math.hypot((a[0]+a[2])/2-(b[0]+b[2])/2, (a[1]+a[3])/2-(b[1]+b[3])/2) if len(a)>=4 and len(b)>=4 else 0.0

    @staticmethod
    def _ts(s: str) -> datetime | None:
        if not s: return None
        try: return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except (ValueError, TypeError): return None

    # ── 5  LLM pattern analysis ───────────────────────────────────────

    async def _llm_pattern_analysis(self) -> dict | None:
        tracking = {}
        for eid, recs in list(self._tracked.items())[:15]:
            tracking[eid] = {"cameras": list({r["camera_id"] for r in recs}), "sightings": len(recs),
                "first": recs[0].get("timestamp") if recs else None,
                "last": recs[-1].get("timestamp") if recs else None,
                "desc": recs[-1].get("description","") if recs else ""}
        comp = [{"entities": g["entities"], "cam": g["camera_id"], "n": g["cooccurrence_count"]}
                for g in self._companions[-10:]]
        result = await self.execute_tool_loop(_PATTERN_PROMPT.format(
            tracking_summary=json.dumps(tracking, default=str)[:3000],
            companion_summary=json.dumps(comp, default=str)[:1500],
            site_context="Use get_site_context tool if you need site layout information."))
        parsed = self._pj(result.get("response", ""))
        if not parsed: return None
        for p in parsed.get("patterns", []):
            sev = p.get("severity", "low")
            if sev in ("medium", "high", "critical"):
                await self.send_message(CH_CORRELATION, {"type": "suspicious_pattern",
                    "subtype": p.get("type","unknown"), "severity": sev,
                    "entities": p.get("entities",[]), "cameras": p.get("cameras",[]),
                    "description": p.get("description",""), "confidence": p.get("confidence",0),
                    "timestamp": datetime.now(timezone.utc).isoformat()})
                await self.learn(f"Pattern: {p.get('type')} — {p.get('description','')[:150]}",
                                 category="suspicious_pattern")
        await self.log_action("pattern_analysis", {"entities_analyzed": len(tracking),
            "patterns_found": len(parsed.get("patterns",[])),
            "response_summary": parsed.get("summary","")[:300]})
        return parsed

    # ── 6  Temporal cluster detection ─────────────────────────────────

    def _temporal_clusters(self, sightings: list[dict]) -> list[dict]:
        by_cam: dict[str, set[str]] = defaultdict(set)
        for s in sightings: by_cam[s["camera_id"]].add(s["entity_id"])
        return [{"camera_id": c, "entity_count": len(e), "entities": list(e)[:10],
                 "severity": "medium" if len(e) < 5 else "high",
                 "description": f"{len(e)} distinct entities at {c} within same cycle"}
                for c, e in by_cam.items() if len(e) >= 3]

    # ── Housekeeping ──────────────────────────────────────────────────

    def _prune(self, now: float) -> None:
        for eid in [e for e, t in self._path_ts.items() if now - t > _PATH_TTL]:
            self._paths.pop(eid, None); self._path_ts.pop(eid, None); self._tracked.pop(eid, None)
        if len(self._cooccur) > 500:
            self._cooccur = defaultdict(int, sorted(self._cooccur.items(), key=lambda x: x[1], reverse=True)[:250])
        self._companions = self._companions[-50:]

    async def _sync_memory(self) -> None:
        summary: dict[str, Any] = {}
        for eid, recs in self._tracked.items():
            if recs:
                summary[eid] = {"cameras": list({r["camera_id"] for r in recs}), "count": len(recs),
                    "last_camera": recs[-1].get("camera_id"), "last_seen": recs[-1].get("timestamp")}
        await self.remember("tracked_entities", summary, ttl=_ENTITY_TTL)
        if self._companions:
            await self.remember("companion_groups", self._companions[-20:], ttl=_ENTITY_TTL)

    @staticmethod
    def _pj(text: str) -> dict | None:
        try: return json.loads(text[text.index("{"):text.rindex("}") + 1])
        except (ValueError, json.JSONDecodeError, TypeError): return None
