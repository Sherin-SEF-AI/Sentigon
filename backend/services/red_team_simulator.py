"""Adversarial Self-Testing — "Red Team AI"

The system simulates attacks against your facility to find vulnerabilities:
  "Optimal intrusion path: parking garage blind spot → stairwell B (no camera)
  → emergency exit (no badge reader) → server room during PTZ sweep gap."

Your security system actively tries to break itself to find vulnerabilities.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models import Camera

logger = logging.getLogger(__name__)

_RED_TEAM_PROMPT = """\
You are a physical security penetration tester planning an intrusion exercise.

**Target:** {target_zone}
**Objective:** {objective}

**Facility Layout:**
- Zones: {zones}
- Camera Coverage: {cameras}
- Access Control Points: {access_points}
- Patrol Schedule: {patrol_schedule}

**Known Vulnerabilities (from system data):**
- Offline cameras: {offline_cameras}
- Doors without badge readers: {uncontrolled_doors}
- Coverage gaps: {coverage_gaps}

Plan the optimal physical intrusion route to reach the target while minimizing
detection probability. For each step, identify the vulnerability exploited.

Respond with JSON:
{{
  "attack_plan": [
    {{
      "step": 1,
      "location": "entry point or area",
      "action": "what the attacker does",
      "vulnerability_exploited": "specific security gap used",
      "detection_probability": 0.0-1.0,
      "time_estimate_seconds": 0,
      "mitigation": "how to fix this vulnerability"
    }}
  ],
  "overall_detection_probability": 0.0-1.0,
  "estimated_time_minutes": 0,
  "difficulty_rating": "trivial|easy|moderate|hard|very_hard",
  "critical_vulnerabilities": [
    {{
      "vulnerability": "description",
      "severity": "critical|high|medium|low",
      "remediation": "specific fix",
      "cost_estimate": "low|medium|high"
    }}
  ],
  "alternative_routes": [
    {{
      "name": "alternative path name",
      "detection_probability": 0.0-1.0,
      "description": "brief description"
    }}
  ],
  "executive_summary": "2-3 sentence summary for management"
}}
"""


class SimulationResult:
    """Represents the result of a red team simulation."""

    def __init__(self, target: str, objective: str) -> None:
        self.simulation_id = f"rt_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        self.target = target
        self.objective = objective
        self.attack_plan: List[Dict] = []
        self.overall_detection_prob: float = 0.0
        self.estimated_time: float = 0.0
        self.difficulty: str = "unknown"
        self.critical_vulnerabilities: List[Dict] = []
        self.alternative_routes: List[Dict] = []
        self.executive_summary: str = ""
        self.created_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "simulation_id": self.simulation_id,
            "target": self.target,
            "objective": self.objective,
            "attack_plan": self.attack_plan,
            "overall_detection_probability": self.overall_detection_prob,
            "estimated_time_minutes": self.estimated_time,
            "difficulty": self.difficulty,
            "critical_vulnerabilities": self.critical_vulnerabilities,
            "alternative_routes": self.alternative_routes,
            "executive_summary": self.executive_summary,
            "total_steps": len(self.attack_plan),
            "total_vulnerabilities": len(self.critical_vulnerabilities),
            "created_at": self.created_at,
        }


class RedTeamSimulator:
    """Simulates adversarial attacks to identify security vulnerabilities.

    Uses Gemini Pro with facility data (zones, cameras, access points,
    patrol schedules) to plan optimal intrusion routes and identify gaps.
    """

    def __init__(self) -> None:
        self._simulation_history: List[Dict] = []

    async def simulate_intrusion(
        self,
        target_zone: str = "server room",
        objective: str = "Reach target zone undetected",
    ) -> SimulationResult:
        """Run a red team simulation against the facility."""
        result = SimulationResult(target_zone, objective)

        # Gather facility intelligence
        zones = await self._get_zones()
        cameras = await self._get_camera_coverage()
        access_points = await self._get_access_points()
        patrol_schedule = await self._get_patrol_schedule()

        # Identify known vulnerabilities
        offline_cameras = [c for c in cameras if c.get("status") != "online"]
        coverage_gaps = self._identify_coverage_gaps(zones, cameras)

        prompt = _RED_TEAM_PROMPT.format(
            target_zone=target_zone,
            objective=objective,
            zones=json.dumps(zones[:20], indent=2, default=str),
            cameras=json.dumps(cameras[:20], indent=2, default=str),
            access_points=json.dumps(access_points[:20], indent=2, default=str),
            patrol_schedule=json.dumps(patrol_schedule, indent=2, default=str),
            offline_cameras=json.dumps([c["name"] for c in offline_cameras[:10]], default=str),
            uncontrolled_doors="See access points list",
            coverage_gaps=json.dumps(coverage_gaps[:10], indent=2, default=str),
        )

        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.4,
                max_tokens=2000,
            )

            if response:
                parsed = self._parse_json(response)
                if parsed:
                    result.attack_plan = parsed.get("attack_plan", [])
                    result.overall_detection_prob = parsed.get("overall_detection_probability", 0.0)
                    result.estimated_time = parsed.get("estimated_time_minutes", 0)
                    result.difficulty = parsed.get("difficulty_rating", "unknown")
                    result.critical_vulnerabilities = parsed.get("critical_vulnerabilities", [])
                    result.alternative_routes = parsed.get("alternative_routes", [])
                    result.executive_summary = parsed.get("executive_summary", "")

        except Exception as e:
            logger.error("redteam.simulation_failed target=%s: %s", target_zone, e)
            result.executive_summary = f"Simulation failed: {e}"

        self._simulation_history.append(result.to_dict())
        if len(self._simulation_history) > 100:
            self._simulation_history = self._simulation_history[-50:]

        logger.info(
            "redteam.simulation target=%s steps=%d vulns=%d difficulty=%s",
            target_zone, len(result.attack_plan),
            len(result.critical_vulnerabilities), result.difficulty,
        )
        return result

    async def vulnerability_assessment(self) -> Dict[str, Any]:
        """Run a comprehensive vulnerability assessment of the entire facility."""
        cameras = await self._get_camera_coverage()
        zones = await self._get_zones()

        online = sum(1 for c in cameras if c.get("status") == "online")
        offline = len(cameras) - online
        gaps = self._identify_coverage_gaps(zones, cameras)

        # Score each vulnerability category
        scores = {
            "camera_coverage": max(0, 100 - offline * 15),
            "coverage_gaps": max(0, 100 - len(gaps) * 20),
            "access_control": 70,  # Default medium — would need real PACS data
            "patrol_coverage": 60,  # Default — would need patrol completion data
        }

        overall = sum(scores.values()) / len(scores)

        return {
            "overall_score": round(overall),
            "grade": "A" if overall >= 90 else "B" if overall >= 75 else "C" if overall >= 60 else "D" if overall >= 40 else "F",
            "scores": scores,
            "cameras": {"online": online, "offline": offline, "total": len(cameras)},
            "coverage_gaps": gaps,
            "recommendations": [
                f"Fix {offline} offline cameras" if offline > 0 else None,
                f"Address {len(gaps)} coverage gaps" if gaps else None,
                "Review access control compliance",
                "Verify patrol route completion rates",
            ],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    async def _get_zones(self) -> List[Dict]:
        try:
            from sqlalchemy import select
            from backend.models.models import Zone
            async with async_session() as session:
                result = await session.execute(select(Zone).limit(50))
                return [
                    {
                        "name": z.name,
                        "type": getattr(z, "zone_type", "general"),
                        "id": str(z.id),
                    }
                    for z in result.scalars().all()
                ]
        except Exception:
            return [{"name": "Main Building", "type": "general"}]

    async def _get_camera_coverage(self) -> List[Dict]:
        try:
            from sqlalchemy import select
            async with async_session() as session:
                result = await session.execute(select(Camera).limit(100))
                return [
                    {
                        "name": c.name,
                        "status": c.status,
                        "location": getattr(c, "location", ""),
                        "zone": getattr(c, "zone_id", ""),
                        "id": str(c.id),
                    }
                    for c in result.scalars().all()
                ]
        except Exception:
            return []

    async def _get_access_points(self) -> List[Dict]:
        try:
            from sqlalchemy import select
            from backend.models.models import Door
            async with async_session() as session:
                result = await session.execute(select(Door).limit(50))
                return [
                    {
                        "name": d.name,
                        "type": getattr(d, "door_type", "standard"),
                        "has_reader": getattr(d, "has_badge_reader", True),
                    }
                    for d in result.scalars().all()
                ]
        except Exception:
            return [{"note": "Access point data not available"}]

    async def _get_patrol_schedule(self) -> List[Dict]:
        try:
            from sqlalchemy import select
            from backend.models.models import PatrolRoute
            async with async_session() as session:
                result = await session.execute(select(PatrolRoute).limit(20))
                return [
                    {"name": r.name, "checkpoints": getattr(r, "checkpoint_count", 0)}
                    for r in result.scalars().all()
                ]
        except Exception:
            return [{"note": "Patrol schedule not available"}]

    def _identify_coverage_gaps(self, zones: List[Dict], cameras: List[Dict]) -> List[Dict]:
        """Identify zones without camera coverage."""
        covered_zones = set()
        for cam in cameras:
            if cam.get("status") == "online" and cam.get("zone"):
                covered_zones.add(str(cam["zone"]))

        gaps = []
        for zone in zones:
            zone_id = str(zone.get("id", ""))
            if zone_id and zone_id not in covered_zones:
                gaps.append({
                    "zone": zone["name"],
                    "type": zone.get("type", "unknown"),
                    "issue": "No active camera coverage",
                })

        return gaps

    def _parse_json(self, text: str) -> Optional[Dict]:
        text = text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    pass
        return None

    def get_history(self, limit: int = 20) -> List[Dict]:
        return self._simulation_history[-limit:]


# ── Singleton ─────────────────────────────────────────────────────
red_team_simulator = RedTeamSimulator()
