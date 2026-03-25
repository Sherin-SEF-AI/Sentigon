"""Explainable AI (XAI) Layer — structured reasoning chains for every alert.

Every detection flows through multiple stages (YOLO, dwell-time, zone rules,
CLIP similarity, Gemini analysis).  The ExplanationBuilder captures evidence
from each stage and produces a human-readable reasoning chain that answers
"WHY did the AI flag this?"

Example output:
    (1) YOLO: person detected 0.94 conf
    (2) Dwell: 4m32s exceeds 2m zone threshold
    (3) Zone: after-hours (22:15, closes 18:00)
    (4) CLIP: 0.87 match to known loitering patterns
    (5) Gemini: 'surveillance posture' confidence 0.71
    → Combined threat score: 0.89 CRITICAL
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Evidence step types ──────────────────────────────────────────────

@dataclass
class EvidenceStep:
    """Single reasoning step in the explanation chain."""
    stage: str            # e.g. "yolo", "dwell_time", "zone_rule", "clip", "gemini", "fp_suppression", "context_profile"
    description: str      # Human-readable description
    value: Any            # The raw value (confidence, seconds, score, etc.)
    threshold: Any = None # The threshold it was compared against (if applicable)
    passed: bool = True   # Did this evidence support or weaken the threat?
    weight: float = 1.0   # How much this step contributed to final score (0.0-1.0)
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ExplanationChain:
    """Complete reasoning chain for a single threat detection."""
    alert_id: Optional[str] = None
    signature_name: str = ""
    category: str = ""
    final_severity: str = ""
    final_confidence: float = 0.0
    steps: List[EvidenceStep] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    summary: str = ""

    def add_step(self, stage: str, description: str, value: Any,
                 threshold: Any = None, passed: bool = True,
                 weight: float = 1.0, details: Optional[Dict] = None) -> None:
        self.steps.append(EvidenceStep(
            stage=stage,
            description=description,
            value=value,
            threshold=threshold,
            passed=passed,
            weight=weight,
            details=details or {},
        ))

    def generate_summary(self) -> str:
        """Build a human-readable one-paragraph summary of the reasoning."""
        supporting = [s for s in self.steps if s.passed]
        weakening = [s for s in self.steps if not s.passed]

        parts = []
        for i, step in enumerate(supporting, 1):
            parts.append(f"({i}) {step.description}")

        summary = " → ".join(parts)
        if weakening:
            weak_text = "; ".join(s.description for s in weakening)
            summary += f" [Mitigating: {weak_text}]"

        summary += f" → Combined: {self.final_confidence:.2f} {self.final_severity}"
        self.summary = summary
        return summary

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alert_id": self.alert_id,
            "signature_name": self.signature_name,
            "category": self.category,
            "final_severity": self.final_severity,
            "final_confidence": self.final_confidence,
            "steps": [s.to_dict() for s in self.steps],
            "summary": self.summary or self.generate_summary(),
            "timestamp": self.timestamp,
            "step_count": len(self.steps),
            "supporting_evidence": len([s for s in self.steps if s.passed]),
            "weakening_evidence": len([s for s in self.steps if not s.passed]),
        }


class ExplanationBuilder:
    """Singleton service that builds XAI explanation chains.

    Collects evidence from each detection stage and produces structured
    reasoning chains stored alongside alerts.
    """

    def __init__(self) -> None:
        self._active_chains: Dict[str, ExplanationChain] = {}

    def start_chain(self, detection_key: str, signature_name: str = "",
                    category: str = "") -> ExplanationChain:
        """Start a new explanation chain for a detection."""
        chain = ExplanationChain(
            signature_name=signature_name,
            category=category,
        )
        self._active_chains[detection_key] = chain
        return chain

    def get_chain(self, detection_key: str) -> Optional[ExplanationChain]:
        return self._active_chains.get(detection_key)

    def close_chain(self, detection_key: str) -> Optional[ExplanationChain]:
        """Finalize and remove chain from active tracking."""
        chain = self._active_chains.pop(detection_key, None)
        if chain:
            chain.generate_summary()
        return chain

    # ── Stage-specific evidence collectors ─────────────────────

    def add_yolo_evidence(self, chain: ExplanationChain,
                          detection: Dict[str, Any],
                          matched_classes: List[str],
                          signature_classes: List[str]) -> None:
        """Record YOLO object detection evidence."""
        det_class = detection.get("class", "unknown")
        det_conf = detection.get("confidence", 0.0)
        bbox = detection.get("bbox", {})

        chain.add_step(
            stage="yolo_detection",
            description=f"YOLO: {det_class} detected at {det_conf:.2f} confidence",
            value=det_conf,
            threshold=0.25,  # typical YOLO threshold
            passed=True,
            weight=0.25,
            details={
                "class": det_class,
                "confidence": det_conf,
                "bbox": bbox,
                "matched_classes": matched_classes,
                "signature_classes": signature_classes,
            },
        )

    def add_dwell_time_evidence(self, chain: ExplanationChain,
                                 actual_dwell: float,
                                 threshold_dwell: float,
                                 is_stationary: bool = False) -> None:
        """Record dwell time / loitering evidence."""
        minutes = actual_dwell / 60
        threshold_min = threshold_dwell / 60
        passed = actual_dwell >= threshold_dwell

        chain.add_step(
            stage="dwell_time",
            description=f"Dwell: {minutes:.1f}m {'exceeds' if passed else 'below'} {threshold_min:.1f}m threshold",
            value=actual_dwell,
            threshold=threshold_dwell,
            passed=passed,
            weight=0.20,
            details={"is_stationary": is_stationary, "seconds": actual_dwell},
        )

    def add_zone_rule_evidence(self, chain: ExplanationChain,
                                zone_name: str,
                                rule_type: str,
                                violated: bool,
                                details: Optional[Dict] = None) -> None:
        """Record zone-based rule evidence (after-hours, restricted, etc.)."""
        desc_map = {
            "after_hours": f"Zone: {zone_name} is after operating hours",
            "restricted": f"Zone: {zone_name} is restricted access",
            "capacity": f"Zone: {zone_name} capacity exceeded",
            "perimeter": f"Zone: {zone_name} perimeter breach",
        }
        description = desc_map.get(rule_type, f"Zone: {zone_name} rule '{rule_type}'")

        chain.add_step(
            stage="zone_rule",
            description=description,
            value=rule_type,
            passed=violated,
            weight=0.20,
            details={"zone_name": zone_name, **(details or {})},
        )

    def add_clip_evidence(self, chain: ExplanationChain,
                          similarity_score: float,
                          matched_pattern: str = "",
                          threshold: float = 0.75) -> None:
        """Record CLIP visual similarity evidence."""
        passed = similarity_score >= threshold

        chain.add_step(
            stage="clip_similarity",
            description=f"CLIP: {similarity_score:.2f} similarity to '{matched_pattern or 'known pattern'}'",
            value=similarity_score,
            threshold=threshold,
            passed=passed,
            weight=0.15,
            details={"matched_pattern": matched_pattern},
        )

    def add_gemini_evidence(self, chain: ExplanationChain,
                            analysis_text: str,
                            indicators: List[Dict[str, Any]],
                            overall_risk: str,
                            keyword_matches: int = 0) -> None:
        """Record Gemini scene analysis evidence."""
        for indicator in indicators:
            conf = indicator.get("confidence", 0.5)
            itype = indicator.get("type", "unknown")
            chain.add_step(
                stage="gemini_analysis",
                description=f"Gemini: '{itype}' detected at {conf:.2f} confidence",
                value=conf,
                passed=True,
                weight=0.20,
                details={
                    "indicator_type": itype,
                    "description": indicator.get("description", ""),
                    "overall_risk": overall_risk,
                },
            )

        if keyword_matches > 0:
            chain.add_step(
                stage="gemini_keywords",
                description=f"Gemini: {keyword_matches} keyword matches in scene analysis",
                value=keyword_matches,
                passed=True,
                weight=0.10,
                details={"overall_risk": overall_risk},
            )

    def add_false_positive_evidence(self, chain: ExplanationChain,
                                     fp_count: int,
                                     confidence_reduction: float) -> None:
        """Record false-positive suppression evidence (weakens the threat)."""
        chain.add_step(
            stage="fp_suppression",
            description=f"FP History: dismissed {fp_count}x, confidence reduced by {confidence_reduction:.2f}",
            value=fp_count,
            threshold=5,
            passed=False,  # This weakens the threat
            weight=-0.15,
            details={"confidence_reduction": confidence_reduction},
        )

    def add_context_profile_evidence(self, chain: ExplanationChain,
                                      original_severity: str,
                                      adjusted_severity: str,
                                      profile_name: str = "") -> None:
        """Record context profile severity adjustment."""
        changed = original_severity != adjusted_severity
        chain.add_step(
            stage="context_profile",
            description=f"Context: severity {'adjusted' if changed else 'unchanged'} "
                        f"{original_severity}→{adjusted_severity}" if changed
                        else f"Context: severity confirmed as {original_severity}",
            value=adjusted_severity,
            passed=True,
            weight=0.0,  # Informational, doesn't affect scoring
            details={
                "original_severity": original_severity,
                "adjusted_severity": adjusted_severity,
                "profile_name": profile_name,
            },
        )

    def add_correlation_evidence(self, chain: ExplanationChain,
                                  correlated_events: int,
                                  cameras_involved: int,
                                  time_span_seconds: float) -> None:
        """Record cross-camera correlation evidence."""
        chain.add_step(
            stage="correlation",
            description=f"Correlation: {correlated_events} events across {cameras_involved} cameras in {time_span_seconds:.0f}s",
            value=correlated_events,
            passed=True,
            weight=0.15,
            details={
                "cameras_involved": cameras_involved,
                "time_span_seconds": time_span_seconds,
            },
        )

    def add_behavioral_evidence(self, chain: ExplanationChain,
                                 behavior_type: str,
                                 score: float,
                                 threshold: float = 0.6) -> None:
        """Record behavioral analysis evidence (micro-behavior, intent, etc.)."""
        passed = score >= threshold
        chain.add_step(
            stage="behavioral",
            description=f"Behavior: '{behavior_type}' scored {score:.2f}",
            value=score,
            threshold=threshold,
            passed=passed,
            weight=0.15,
            details={"behavior_type": behavior_type},
        )

    def add_prediction_evidence(self, chain: ExplanationChain,
                                 prediction_type: str,
                                 probability: float,
                                 eta_seconds: Optional[float] = None) -> None:
        """Record predictive intelligence evidence."""
        desc = f"Prediction: {prediction_type} at {probability:.0%} probability"
        if eta_seconds is not None:
            desc += f", ETA {eta_seconds:.0f}s"

        chain.add_step(
            stage="prediction",
            description=desc,
            value=probability,
            passed=True,
            weight=0.10,
            details={
                "prediction_type": prediction_type,
                "eta_seconds": eta_seconds,
            },
        )

    # ── Bulk evidence from threat evaluation ─────────────────

    def build_from_threat(self, threat: Dict[str, Any],
                          detections: Optional[Dict] = None,
                          gemini_analysis: Optional[Dict] = None,
                          zone_info: Optional[Dict] = None) -> ExplanationChain:
        """Build a complete explanation chain from a finalized threat dict.

        This is the high-level method called after evaluate_hybrid() to
        retroactively construct the explanation from available data.
        """
        chain = ExplanationChain(
            signature_name=threat.get("signature", "Unknown"),
            category=threat.get("category", ""),
            final_severity=threat.get("severity", "medium"),
            final_confidence=threat.get("confidence", 0.0),
        )

        # YOLO evidence
        if detections and threat.get("detection_method") in ("yolo", "hybrid"):
            for det in detections.get("detections", []):
                det_class = det.get("class", "")
                det_conf = det.get("confidence", 0.0)
                chain.add_step(
                    stage="yolo_detection",
                    description=f"YOLO: {det_class} detected at {det_conf:.2f} confidence",
                    value=det_conf,
                    passed=True,
                    weight=0.25,
                    details={"class": det_class, "bbox": det.get("bbox", {})},
                )

                # Dwell time
                dwell = det.get("dwell_time", 0)
                if dwell > 0:
                    chain.add_step(
                        stage="dwell_time",
                        description=f"Dwell: {dwell/60:.1f}m observed",
                        value=dwell,
                        passed=True,
                        weight=0.15,
                    )

        # Zone evidence
        if zone_info:
            zone_name = zone_info.get("name", zone_info.get("zone_name", "Unknown"))
            zone_type = zone_info.get("zone_type", "")
            if zone_type in ("restricted", "secure", "perimeter"):
                chain.add_step(
                    stage="zone_rule",
                    description=f"Zone: {zone_name} ({zone_type} area)",
                    value=zone_type,
                    passed=True,
                    weight=0.20,
                    details={"zone_name": zone_name, "zone_type": zone_type},
                )

        # Gemini evidence
        if gemini_analysis and threat.get("detection_method") in ("gemini", "gemini_keyword", "hybrid"):
            risk = gemini_analysis.get("overall_risk", "low")
            for indicator in gemini_analysis.get("threat_indicators", []):
                conf = indicator.get("confidence", 0.5)
                chain.add_step(
                    stage="gemini_analysis",
                    description=f"Gemini: '{indicator.get('type', 'analysis')}' at {conf:.2f} confidence",
                    value=conf,
                    passed=True,
                    weight=0.20,
                    details={"overall_risk": risk},
                )

            anomalies = gemini_analysis.get("anomalies", [])
            if anomalies:
                chain.add_step(
                    stage="gemini_anomalies",
                    description=f"Gemini: {len(anomalies)} anomalies detected in scene",
                    value=len(anomalies),
                    passed=True,
                    weight=0.10,
                    details={"anomalies": anomalies[:5]},
                )

        # Context profile adjustment
        if threat.get("context_adjusted"):
            chain.add_step(
                stage="context_profile",
                description=f"Context: severity adjusted {threat.get('original_severity')}→{threat.get('severity')}",
                value=threat.get("severity"),
                passed=True,
                weight=0.0,
            )

        # Hybrid boost
        if threat.get("detection_method") == "hybrid":
            chain.add_step(
                stage="hybrid_boost",
                description="Hybrid: YOLO + Gemini agreement boosted confidence",
                value="hybrid",
                passed=True,
                weight=0.10,
            )

        chain.generate_summary()
        return chain


# ── Singleton ─────────────────────────────────────────────────────
explanation_builder = ExplanationBuilder()
