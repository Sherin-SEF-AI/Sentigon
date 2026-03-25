"""Natural Language Policy Builder — convert plain English rules to threat signatures.

Uses Gemini to parse natural language security rules into structured
ThreatSignatureDef fields, validates them, and persists to DB + in-memory engine.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Structured output prompt for Gemini NL-to-signature parsing
_NL_PARSE_PROMPT = """\
You are a security policy parser for an AI surveillance system. Convert the \
following natural language security rule into a structured threat signature.

**Natural language rule:**
{rule_text}

**Available threat categories:**
intrusion, suspicious, violence, theft, vehicle, safety, occupancy, operational, \
behavioral, compliance, cyber_physical, insider_threat, terrorism, child_safety, \
animal_threat, infrastructure, medical_biohazard, retail_commercial, parking, \
active_shooter, escape_evasion, social_unrest, micro_behavior

**Available severity levels:** info, low, medium, high, critical

**Available YOLO detection classes:**
person, car, truck, bus, motorcycle, bicycle, backpack, handbag, suitcase, \
knife, cell phone, laptop, umbrella, dog, cat, skateboard

**Available conditions:**
- dwell_time_min: minimum seconds an object has been present (number)
- is_stationary: whether the object is not moving (boolean)
- zone_type: zone classification e.g. "restricted" (string)
- near_perimeter: whether near the site perimeter (boolean)
- person_count_min: minimum number of people visible (number)
- time_window: "off_hours" or "business_hours" (string)

Parse the rule and respond with ONLY valid JSON (no markdown):
{{
  "name": "<short descriptive name, max 80 chars>",
  "category": "<one of the categories above>",
  "severity": "<one of the severity levels>",
  "detection_method": "<yolo|gemini|hybrid>",
  "description": "<1-2 sentence description>",
  "yolo_classes": ["<class1>", ...],
  "conditions": {{"<condition_key>": <value>, ...}},
  "gemini_keywords": ["<keyword1>", "<keyword2>", ...],
  "confidence": <0.0-1.0 how confident you are in this parsing>
}}
"""


class NLPolicyEngine:
    """Parses natural language security rules into threat signatures."""

    def __init__(self):
        self._valid_categories = {
            "intrusion", "suspicious", "violence", "theft", "vehicle",
            "safety", "occupancy", "operational", "behavioral", "compliance",
            "cyber_physical", "insider_threat", "terrorism", "child_safety",
            "animal_threat", "infrastructure", "medical_biohazard",
            "retail_commercial", "parking", "active_shooter", "escape_evasion",
            "social_unrest", "micro_behavior",
        }
        self._valid_severities = {"info", "low", "medium", "high", "critical"}
        self._valid_methods = {"yolo", "gemini", "hybrid"}
        self._valid_yolo_classes = {
            "person", "car", "truck", "bus", "motorcycle", "bicycle",
            "backpack", "handbag", "suitcase", "knife", "cell phone",
            "laptop", "umbrella", "dog", "cat", "skateboard",
        }
        self._valid_conditions = {
            "dwell_time_min", "is_stationary", "zone_type",
            "near_perimeter", "person_count_min", "time_window",
            "check_max_occupancy", "unattended_time_min",
            "pose_blading", "pose_target_fixation", "pose_pre_assault",
            "pose_staking", "pose_concealed_carry", "pose_evasive",
        }

    async def parse_rule(self, natural_language: str) -> Dict[str, Any]:
        """Send NL rule to Gemini and parse the structured response.

        Returns parsed signature fields dict with 'confidence' key.
        """
        from backend.services.ai_text_service import ai_generate_text

        prompt = _NL_PARSE_PROMPT.format(rule_text=natural_language)

        response = await ai_generate_text(
            prompt=prompt,
            temperature=0.1,
            max_tokens=1000,
        )

        if not response:
            raise ValueError("AI returned empty response")

        return self._extract_json(response)

    def validate_parsed_rule(self, parsed: Dict[str, Any]) -> List[str]:
        """Validate parsed rule fields. Returns list of error messages (empty if valid)."""
        errors = []

        name = parsed.get("name", "")
        if not name or len(name) < 3:
            errors.append("Name must be at least 3 characters")
        if len(name) > 80:
            errors.append("Name must be 80 characters or fewer")

        category = parsed.get("category", "")
        if category not in self._valid_categories:
            errors.append(f"Invalid category '{category}'. Must be one of: {sorted(self._valid_categories)}")

        severity = parsed.get("severity", "")
        if severity not in self._valid_severities:
            errors.append(f"Invalid severity '{severity}'. Must be one of: {sorted(self._valid_severities)}")

        method = parsed.get("detection_method", "")
        if method not in self._valid_methods:
            errors.append(f"Invalid detection_method '{method}'. Must be one of: {sorted(self._valid_methods)}")

        yolo_classes = parsed.get("yolo_classes", [])
        if yolo_classes:
            for cls in yolo_classes:
                if cls not in self._valid_yolo_classes:
                    errors.append(f"Invalid YOLO class '{cls}'")

        conditions = parsed.get("conditions", {})
        if conditions:
            for key in conditions:
                if key not in self._valid_conditions:
                    errors.append(f"Unknown condition '{key}'")

        keywords = parsed.get("gemini_keywords", [])
        if method in ("gemini", "hybrid") and not keywords:
            errors.append("gemini_keywords required for gemini/hybrid detection methods")

        return errors

    async def create_signature_from_nl(
        self,
        natural_language: str,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Full pipeline: parse NL → validate → persist to DB → load into engine.

        Returns dict with created signature info.
        """
        # 1. Parse
        parsed = await self.parse_rule(natural_language)

        # 2. Validate
        errors = self.validate_parsed_rule(parsed)
        if errors:
            return {
                "success": False,
                "errors": errors,
                "parsed": parsed,
            }

        # 3. Persist to DB
        from backend.database import async_session
        from backend.models.models import ThreatSignature, AlertSeverity

        severity_map = {
            "critical": AlertSeverity.CRITICAL,
            "high": AlertSeverity.HIGH,
            "medium": AlertSeverity.MEDIUM,
            "low": AlertSeverity.LOW,
            "info": AlertSeverity.INFO,
        }

        try:
            async with async_session() as session:
                db_sig = ThreatSignature(
                    name=parsed["name"],
                    category=parsed["category"],
                    description=parsed.get("description", ""),
                    severity=severity_map.get(parsed["severity"], AlertSeverity.MEDIUM),
                    detection_method=parsed["detection_method"],
                    yolo_classes=parsed.get("yolo_classes", []),
                    gemini_keywords=parsed.get("gemini_keywords", []),
                    conditions=parsed.get("conditions", {}),
                    is_active=True,
                    source="nl_policy",
                    detection_count=0,
                )
                session.add(db_sig)
                await session.commit()
                await session.refresh(db_sig)

                sig_id = str(db_sig.id)
        except Exception as e:
            logger.error("NL policy DB persist failed: %s", e)
            return {
                "success": False,
                "errors": [f"Database error: {e}"],
                "parsed": parsed,
            }

        # 4. Load into in-memory engine
        from backend.services.threat_engine import threat_engine, ThreatSignatureDef

        sig_def = ThreatSignatureDef(
            name=parsed["name"],
            category=parsed["category"],
            severity=parsed["severity"],
            detection_method=parsed["detection_method"],
            description=parsed.get("description", ""),
            yolo_classes=parsed.get("yolo_classes", []),
            conditions=parsed.get("conditions", {}),
            gemini_keywords=parsed.get("gemini_keywords", []),
        )
        threat_engine.signatures[parsed["name"]] = sig_def

        logger.info(
            "NL policy created: name='%s' category='%s' severity='%s' source=nl_policy",
            parsed["name"], parsed["category"], parsed["severity"],
        )

        return {
            "success": True,
            "signature_id": sig_id,
            "name": parsed["name"],
            "category": parsed["category"],
            "severity": parsed["severity"],
            "detection_method": parsed["detection_method"],
            "description": parsed.get("description", ""),
            "yolo_classes": parsed.get("yolo_classes", []),
            "gemini_keywords": parsed.get("gemini_keywords", []),
            "conditions": parsed.get("conditions", {}),
            "parse_confidence": parsed.get("confidence", 0.0),
            "total_signatures": threat_engine.get_signature_count(),
        }

    @staticmethod
    def _extract_json(text: str) -> Dict[str, Any]:
        """Extract JSON object from Gemini response text."""
        # Try direct parse first
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Try to find JSON block
        try:
            start = text.index("{")
            end = text.rindex("}") + 1
            return json.loads(text[start:end])
        except (ValueError, json.JSONDecodeError) as e:
            raise ValueError(f"Could not extract valid JSON from response: {e}")


# Singleton
nl_policy_engine = NLPolicyEngine()
