"""SOC 2 / ISO 27001 compliance audit service.

Continuous control monitoring and evidence collection for auditors.
"""
import logging
from datetime import datetime, timezone
from typing import Dict, List
from dataclasses import dataclass, field
import uuid

logger = logging.getLogger(__name__)

SOC2_CONTROLS = {
    "CC1.1": {"name": "COSO Principle 1", "category": "Control Environment", "description": "The entity demonstrates a commitment to integrity and ethical values"},
    "CC2.1": {"name": "Communication & Information", "category": "Communication", "description": "Information required to support internal controls is identified and communicated"},
    "CC3.1": {"name": "Risk Assessment", "category": "Risk Assessment", "description": "The entity specifies objectives with sufficient clarity"},
    "CC5.1": {"name": "Control Activities", "category": "Control Activities", "description": "Entity selects and develops control activities"},
    "CC6.1": {"name": "Logical Access", "category": "Logical Access", "description": "Logical access security controls"},
    "CC6.2": {"name": "Access Provisioning", "category": "Logical Access", "description": "Access provisioned based on authorization"},
    "CC6.3": {"name": "Access Modification", "category": "Logical Access", "description": "Access removed when no longer needed"},
    "CC7.1": {"name": "System Monitoring", "category": "System Operations", "description": "The entity monitors system components"},
    "CC7.2": {"name": "Anomaly Detection", "category": "System Operations", "description": "The entity monitors for anomalies"},
    "CC8.1": {"name": "Change Management", "category": "Change Management", "description": "Changes to infrastructure are authorized"},
    "CC9.1": {"name": "Risk Mitigation", "category": "Risk Mitigation", "description": "The entity identifies and mitigates risks"},
}

@dataclass
class ControlStatus:
    control_id: str
    status: str = "not_assessed"  # compliant, non_compliant, partially_compliant, not_assessed
    last_assessed: str = ""
    evidence_count: int = 0
    notes: str = ""
    assessor: str = ""


class ComplianceAuditService:
    def __init__(self):
        self._control_statuses: Dict[str, ControlStatus] = {}
        self._evidence: List[dict] = []

    def get_all_controls(self) -> List[dict]:
        result = []
        for ctrl_id, ctrl_info in SOC2_CONTROLS.items():
            status = self._control_statuses.get(ctrl_id)
            result.append({
                "id": ctrl_id,
                **ctrl_info,
                "status": status.status if status else "not_assessed",
                "last_assessed": status.last_assessed if status else None,
                "evidence_count": status.evidence_count if status else 0,
            })
        return result

    def assess_control(self, control_id: str, status: str, notes: str, assessor: str) -> dict:
        if control_id not in SOC2_CONTROLS:
            return {"error": "Control not found"}
        cs = ControlStatus(
            control_id=control_id,
            status=status,
            last_assessed=datetime.now(timezone.utc).isoformat(),
            notes=notes,
            assessor=assessor,
        )
        self._control_statuses[control_id] = cs
        logger.info("Compliance control assessed: %s -> %s by %s", control_id, status, assessor)
        return vars(cs)

    def add_evidence(self, control_id: str, evidence_type: str, description: str, file_path: str = "") -> dict:
        if control_id not in SOC2_CONTROLS:
            return {"error": "Control not found"}
        ev = {
            "id": str(uuid.uuid4())[:8],
            "control_id": control_id,
            "type": evidence_type,
            "description": description,
            "file_path": file_path,
            "collected_at": datetime.now(timezone.utc).isoformat(),
        }
        self._evidence.append(ev)
        if control_id in self._control_statuses:
            self._control_statuses[control_id].evidence_count += 1
        return ev

    def get_evidence(self, control_id: str) -> List[dict]:
        return [e for e in self._evidence if e["control_id"] == control_id]

    def get_compliance_summary(self) -> dict:
        total = len(SOC2_CONTROLS)
        assessed = len(self._control_statuses)
        compliant = sum(1 for s in self._control_statuses.values() if s.status == "compliant")
        return {
            "total_controls": total,
            "assessed": assessed,
            "compliant": compliant,
            "non_compliant": sum(1 for s in self._control_statuses.values() if s.status == "non_compliant"),
            "partially_compliant": sum(1 for s in self._control_statuses.values() if s.status == "partially_compliant"),
            "not_assessed": total - assessed,
            "compliance_percentage": round((compliant / total) * 100, 1) if total > 0 else 0,
            "evidence_collected": len(self._evidence),
        }

    def export_audit_report(self) -> dict:
        """Generate a structured audit report for external auditors."""
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "framework": "SOC 2 Type II",
            "summary": self.get_compliance_summary(),
            "controls": self.get_all_controls(),
            "evidence_index": [
                {"id": e["id"], "control_id": e["control_id"], "type": e["type"], "collected_at": e["collected_at"]}
                for e in self._evidence
            ],
        }


compliance_audit_service = ComplianceAuditService()
