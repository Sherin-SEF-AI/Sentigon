"""Industry-specific security templates for the Sentinel AI platform.

Each template provides pre-configured threat signatures, zone types,
emergency codes, SLA targets, and sensitivity presets for a given
industry vertical so operators can bootstrap a new site quickly.
"""

from __future__ import annotations

INDUSTRY_TEMPLATES: dict[str, dict] = {
    "hospital": {
        "name": "Healthcare Facility",
        "description": "Optimized for hospitals, clinics, and medical centers",
        "threat_signatures": [
            {
                "name": "Patient Elopement",
                "category": "safety",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"object_class": "person", "zone_type": "exit", "behavior": "unauthorized_exit"},
            },
            {
                "name": "Weapon Detection",
                "category": "weapon",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"object_class": "weapon"},
            },
            {
                "name": "Infant Ward Breach",
                "category": "access",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "restricted", "zone_name": "nursery"},
            },
            {
                "name": "Staff Duress",
                "category": "safety",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "duress_signal"},
            },
            {
                "name": "Restricted Area Access",
                "category": "access",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "restricted"},
            },
            {
                "name": "Pharmacy Intrusion",
                "category": "access",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "restricted", "zone_name": "pharmacy"},
            },
            {
                "name": "Aggressive Behavior",
                "category": "behavioral",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "aggressive"},
            },
            {
                "name": "Loitering Near Emergency Exit",
                "category": "behavioral",
                "severity": "medium",
                "detection_method": "yolo",
                "conditions": {"behavior": "loitering", "zone_type": "exit"},
            },
        ],
        "zone_types": [
            "emergency_department",
            "icu",
            "nursery",
            "pharmacy",
            "restricted",
            "waiting_area",
            "parking",
            "lobby",
            "corridor",
        ],
        "emergency_codes": [
            {
                "code": "Code Blue",
                "color": "#3b82f6",
                "description": "Cardiac/respiratory arrest",
                "actions": ["page_team", "bring_cart", "clear_area"],
            },
            {
                "code": "Code Red",
                "color": "#ef4444",
                "description": "Fire",
                "actions": ["evacuate_zone", "call_fire_dept", "close_doors"],
            },
            {
                "code": "Code Silver",
                "color": "#6b7280",
                "description": "Active shooter/weapon",
                "actions": ["lockdown", "hide", "notify_police"],
            },
            {
                "code": "Code Pink",
                "color": "#ec4899",
                "description": "Infant/child abduction",
                "actions": ["lock_exits", "check_cameras", "notify_police"],
            },
            {
                "code": "Code Orange",
                "color": "#f97316",
                "description": "Hazmat spill",
                "actions": ["evacuate_zone", "ventilation_off", "hazmat_team"],
            },
            {
                "code": "Code Gray",
                "color": "#9ca3af",
                "description": "Combative person",
                "actions": ["security_respond", "clear_area", "document"],
            },
            {
                "code": "Code Black",
                "color": "#1f2937",
                "description": "Bomb threat",
                "actions": ["evacuate_building", "search_protocol", "notify_police"],
            },
        ],
        "sla_targets": {"critical": 120, "high": 600, "medium": 1800, "low": 7200},
        "sensitivity_presets": {
            "perception": 0.75,
            "anomaly_threshold": 0.6,
            "threat_escalation": 0.7,
            "crowd_density": 0.5,
        },
    },
    "mall": {
        "name": "Retail & Shopping Center",
        "description": "Optimized for malls, retail stores, and commercial centers",
        "threat_signatures": [
            {
                "name": "Shoplifting Detection",
                "category": "theft",
                "severity": "medium",
                "detection_method": "gemini",
                "conditions": {"behavior": "concealment"},
            },
            {
                "name": "Crowd Density Alert",
                "category": "crowd",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"crowd_density": "high"},
            },
            {
                "name": "Unattended Bag",
                "category": "suspicious",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"object_class": "bag", "behavior": "abandoned"},
            },
            {
                "name": "After-Hours Intrusion",
                "category": "access",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"time_context": "closed", "object_class": "person"},
            },
            {
                "name": "Parking Lot Loitering",
                "category": "behavioral",
                "severity": "medium",
                "detection_method": "yolo",
                "conditions": {"behavior": "loitering", "zone_type": "parking"},
            },
            {
                "name": "Vehicle Theft Attempt",
                "category": "theft",
                "severity": "critical",
                "detection_method": "gemini",
                "conditions": {"behavior": "break_in", "zone_type": "parking"},
            },
            {
                "name": "Fire/Smoke Detection",
                "category": "safety",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"object_class": "fire"},
            },
            {
                "name": "Escalator Safety",
                "category": "safety",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "unsafe_escalator"},
            },
        ],
        "zone_types": [
            "retail_floor",
            "food_court",
            "parking_garage",
            "loading_dock",
            "storage",
            "entrance",
            "exit",
            "corridor",
            "restroom",
        ],
        "emergency_codes": [
            {
                "code": "Code Adam",
                "color": "#f59e0b",
                "description": "Missing child",
                "actions": ["lock_exits", "pa_announcement", "check_cameras"],
            },
            {
                "code": "Evacuate",
                "color": "#ef4444",
                "description": "Building evacuation",
                "actions": ["pa_announcement", "open_exits", "guide_to_assembly"],
            },
            {
                "code": "Shelter",
                "color": "#3b82f6",
                "description": "Severe weather shelter",
                "actions": ["pa_announcement", "interior_rooms", "close_exterior"],
            },
        ],
        "sla_targets": {"critical": 180, "high": 900, "medium": 3600, "low": 14400},
        "sensitivity_presets": {
            "perception": 0.65,
            "anomaly_threshold": 0.5,
            "threat_escalation": 0.6,
            "crowd_density": 0.7,
        },
    },
    "smart_city": {
        "name": "Smart City & Public Safety",
        "description": "Optimized for city surveillance, transportation hubs, and public spaces",
        "threat_signatures": [
            {
                "name": "Traffic Violation",
                "category": "traffic",
                "severity": "low",
                "detection_method": "yolo",
                "conditions": {"object_class": "vehicle", "behavior": "violation"},
            },
            {
                "name": "Crowd Stampede Risk",
                "category": "crowd",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"crowd_density": "critical", "crowd_flow": "chaotic"},
            },
            {
                "name": "Illegal Dumping",
                "category": "environmental",
                "severity": "medium",
                "detection_method": "gemini",
                "conditions": {"behavior": "dumping"},
            },
            {
                "name": "Vandalism",
                "category": "property",
                "severity": "medium",
                "detection_method": "gemini",
                "conditions": {"behavior": "vandalism"},
            },
            {
                "name": "Street Fight",
                "category": "violence",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"behavior": "fighting"},
            },
            {
                "name": "Gunshot Detection",
                "category": "weapon",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"audio_class": "gunshot"},
            },
            {
                "name": "Suspicious Package",
                "category": "suspicious",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"object_class": "bag", "behavior": "abandoned"},
            },
            {
                "name": "Unauthorized Drone",
                "category": "airspace",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"object_class": "drone"},
            },
        ],
        "zone_types": [
            "intersection",
            "park",
            "transit_station",
            "plaza",
            "waterfront",
            "commercial_district",
            "residential",
            "school_zone",
            "government",
        ],
        "emergency_codes": [],
        "sla_targets": {"critical": 60, "high": 300, "medium": 1800, "low": 7200},
        "sensitivity_presets": {
            "perception": 0.7,
            "anomaly_threshold": 0.55,
            "threat_escalation": 0.65,
            "crowd_density": 0.8,
        },
    },
    "enterprise": {
        "name": "Corporate & Enterprise",
        "description": "Optimized for corporate offices, data centers, and business parks",
        "threat_signatures": [
            {
                "name": "Tailgating Detection",
                "category": "access",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"behavior": "tailgating"},
            },
            {
                "name": "After-Hours Access",
                "category": "access",
                "severity": "medium",
                "detection_method": "hybrid",
                "conditions": {"time_context": "off_hours", "object_class": "person"},
            },
            {
                "name": "Server Room Breach",
                "category": "access",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "server_room"},
            },
            {
                "name": "Data Exfiltration Risk",
                "category": "insider",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "unusual_equipment"},
            },
            {
                "name": "Visitor Escort Violation",
                "category": "access",
                "severity": "medium",
                "detection_method": "hybrid",
                "conditions": {"visitor_status": "unescorted"},
            },
            {
                "name": "Perimeter Breach",
                "category": "access",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"zone_type": "perimeter", "behavior": "climbing"},
            },
            {
                "name": "Executive Area Intrusion",
                "category": "access",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "executive"},
            },
            {
                "name": "Suspicious Photography",
                "category": "espionage",
                "severity": "medium",
                "detection_method": "gemini",
                "conditions": {"behavior": "photography"},
            },
        ],
        "zone_types": [
            "lobby",
            "office_floor",
            "executive_suite",
            "server_room",
            "parking_garage",
            "loading_dock",
            "conference_room",
            "cafeteria",
            "perimeter",
        ],
        "emergency_codes": [
            {
                "code": "Lockdown",
                "color": "#ef4444",
                "description": "Building lockdown",
                "actions": ["lock_all_doors", "shelter_in_place", "notify_security"],
            },
            {
                "code": "Evacuate",
                "color": "#f97316",
                "description": "Building evacuation",
                "actions": ["unlock_exits", "pa_announcement", "assembly_point"],
            },
        ],
        "sla_targets": {"critical": 120, "high": 600, "medium": 1800, "low": 7200},
        "sensitivity_presets": {
            "perception": 0.7,
            "anomaly_threshold": 0.65,
            "threat_escalation": 0.7,
            "crowd_density": 0.4,
        },
    },
    "government": {
        "name": "Government & Military",
        "description": "High-security facilities, government buildings, and military installations",
        "threat_signatures": [
            {
                "name": "Perimeter Intrusion",
                "category": "access",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "perimeter"},
            },
            {
                "name": "Weapon Detection",
                "category": "weapon",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"object_class": "weapon"},
            },
            {
                "name": "Unauthorized Vehicle",
                "category": "access",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"vehicle_status": "unregistered"},
            },
            {
                "name": "Drone Intrusion",
                "category": "airspace",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"object_class": "drone"},
            },
            {
                "name": "Classified Area Breach",
                "category": "access",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "classified"},
            },
            {
                "name": "Protest/Demonstration",
                "category": "crowd",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"crowd_behavior": "protest"},
            },
        ],
        "zone_types": [
            "checkpoint",
            "classified",
            "admin",
            "perimeter",
            "motor_pool",
            "armory",
            "barracks",
            "headquarters",
        ],
        "emergency_codes": [
            {
                "code": "FPCON Delta",
                "color": "#ef4444",
                "description": "Maximum force protection",
                "actions": ["full_lockdown", "armed_response", "evacuate_nonessential"],
            },
            {
                "code": "FPCON Charlie",
                "color": "#f97316",
                "description": "Elevated threat",
                "actions": ["enhanced_screening", "increased_patrols", "restrict_access"],
            },
        ],
        "sla_targets": {"critical": 60, "high": 180, "medium": 600, "low": 3600},
        "sensitivity_presets": {
            "perception": 0.85,
            "anomaly_threshold": 0.5,
            "threat_escalation": 0.8,
            "crowd_density": 0.6,
        },
    },
    "education": {
        "name": "Education & Campus",
        "description": "Schools, universities, and educational institutions",
        "threat_signatures": [
            {
                "name": "Weapon on Campus",
                "category": "weapon",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"object_class": "weapon"},
            },
            {
                "name": "Unauthorized Adult",
                "category": "access",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "unfamiliar_adult"},
            },
            {
                "name": "Bullying Detection",
                "category": "behavioral",
                "severity": "medium",
                "detection_method": "gemini",
                "conditions": {"behavior": "aggressive_group"},
            },
            {
                "name": "Vaping/Smoking",
                "category": "policy",
                "severity": "low",
                "detection_method": "gemini",
                "conditions": {"behavior": "smoking"},
            },
            {
                "name": "After-Hours Campus Access",
                "category": "access",
                "severity": "medium",
                "detection_method": "yolo",
                "conditions": {"time_context": "off_hours"},
            },
            {
                "name": "Vehicle Speed on Campus",
                "category": "safety",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"vehicle_speed": "excessive"},
            },
        ],
        "zone_types": [
            "classroom",
            "playground",
            "gymnasium",
            "cafeteria",
            "parking_lot",
            "admin_office",
            "library",
            "entrance",
            "sports_field",
        ],
        "emergency_codes": [
            {
                "code": "Lockdown",
                "color": "#ef4444",
                "description": "Active threat on campus",
                "actions": ["lock_doors", "lights_off", "hide", "call_911"],
            },
            {
                "code": "Lockout",
                "color": "#f97316",
                "description": "External threat nearby",
                "actions": ["lock_exterior", "continue_inside", "monitor"],
            },
            {
                "code": "Shelter",
                "color": "#3b82f6",
                "description": "Severe weather",
                "actions": ["interior_hallways", "away_from_windows", "headcount"],
            },
            {
                "code": "Evacuate",
                "color": "#10b981",
                "description": "Building evacuation",
                "actions": ["orderly_exit", "assembly_point", "headcount"],
            },
        ],
        "sla_targets": {"critical": 60, "high": 300, "medium": 1800, "low": 7200},
        "sensitivity_presets": {
            "perception": 0.8,
            "anomaly_threshold": 0.55,
            "threat_escalation": 0.75,
            "crowd_density": 0.6,
        },
    },
    "transportation": {
        "name": "Transportation & Logistics",
        "description": "Airports, train stations, ports, and logistics hubs",
        "threat_signatures": [
            {
                "name": "Unattended Luggage",
                "category": "suspicious",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"object_class": "luggage", "behavior": "abandoned"},
            },
            {
                "name": "Restricted Area Breach",
                "category": "access",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"zone_type": "restricted"},
            },
            {
                "name": "Crowd Surge",
                "category": "crowd",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"crowd_flow": "surge"},
            },
            {
                "name": "Track/Runway Intrusion",
                "category": "safety",
                "severity": "critical",
                "detection_method": "yolo",
                "conditions": {"zone_type": "track", "object_class": "person"},
            },
            {
                "name": "Cargo Tampering",
                "category": "theft",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "tampering", "zone_type": "cargo"},
            },
            {
                "name": "Contraband Detection",
                "category": "security",
                "severity": "high",
                "detection_method": "gemini",
                "conditions": {"behavior": "suspicious_transfer"},
            },
        ],
        "zone_types": [
            "terminal",
            "platform",
            "cargo_area",
            "runway",
            "parking",
            "security_checkpoint",
            "ticketing",
            "baggage_claim",
            "restricted",
        ],
        "emergency_codes": [],
        "sla_targets": {"critical": 60, "high": 300, "medium": 1200, "low": 3600},
        "sensitivity_presets": {
            "perception": 0.8,
            "anomaly_threshold": 0.6,
            "threat_escalation": 0.75,
            "crowd_density": 0.75,
        },
    },
    "manufacturing": {
        "name": "Manufacturing & Industrial",
        "description": "Factories, warehouses, and industrial facilities",
        "threat_signatures": [
            {
                "name": "PPE Violation",
                "category": "safety",
                "severity": "medium",
                "detection_method": "yolo",
                "conditions": {"ppe_missing": True},
            },
            {
                "name": "Forklift Safety Zone",
                "category": "safety",
                "severity": "high",
                "detection_method": "yolo",
                "conditions": {"object_class": "forklift", "behavior": "pedestrian_proximity"},
            },
            {
                "name": "Slip/Fall Detection",
                "category": "safety",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"behavior": "fall"},
            },
            {
                "name": "Unauthorized Machine Access",
                "category": "safety",
                "severity": "critical",
                "detection_method": "hybrid",
                "conditions": {"zone_type": "machinery", "access": "unauthorized"},
            },
            {
                "name": "Chemical Spill",
                "category": "hazmat",
                "severity": "critical",
                "detection_method": "gemini",
                "conditions": {"behavior": "spill"},
            },
            {
                "name": "Loading Dock Theft",
                "category": "theft",
                "severity": "high",
                "detection_method": "hybrid",
                "conditions": {"behavior": "unauthorized_loading", "zone_type": "loading_dock"},
            },
        ],
        "zone_types": [
            "production_floor",
            "warehouse",
            "loading_dock",
            "chemical_storage",
            "office",
            "break_room",
            "parking",
            "perimeter",
            "machinery_zone",
        ],
        "emergency_codes": [],
        "sla_targets": {"critical": 120, "high": 600, "medium": 1800, "low": 7200},
        "sensitivity_presets": {
            "perception": 0.75,
            "anomaly_threshold": 0.6,
            "threat_escalation": 0.65,
            "crowd_density": 0.4,
        },
    },
}

_DEFAULT_SLA: dict[str, int] = {"critical": 120, "high": 600, "medium": 1800, "low": 7200}


def get_template(industry: str) -> dict | None:
    """Return the full template dict for *industry*, or None if unknown."""
    return INDUSTRY_TEMPLATES.get(industry)


def get_all_industries() -> list[dict]:
    """Return a lightweight list of all industries (id, name, description)."""
    return [
        {"id": k, "name": v["name"], "description": v["description"]}
        for k, v in INDUSTRY_TEMPLATES.items()
    ]


def get_threat_signatures_for_industry(industry: str) -> list[dict]:
    """Return the pre-configured threat signatures for *industry*."""
    tmpl = INDUSTRY_TEMPLATES.get(industry)
    return tmpl["threat_signatures"] if tmpl else []


def get_emergency_codes_for_industry(industry: str) -> list[dict]:
    """Return the emergency codes defined for *industry* (may be empty)."""
    tmpl = INDUSTRY_TEMPLATES.get(industry)
    return tmpl.get("emergency_codes", []) if tmpl else []


def get_zone_types_for_industry(industry: str) -> list[str]:
    """Return the recommended zone types for *industry*."""
    tmpl = INDUSTRY_TEMPLATES.get(industry)
    return tmpl.get("zone_types", []) if tmpl else []


def get_sla_targets_for_industry(industry: str) -> dict:
    """Return response-time SLA targets (in seconds) for *industry*.

    Falls back to conservative defaults if the industry is not found.
    """
    tmpl = INDUSTRY_TEMPLATES.get(industry)
    return tmpl.get("sla_targets", _DEFAULT_SLA) if tmpl else {}


def get_sensitivity_presets_for_industry(industry: str) -> dict:
    """Return AI sensitivity presets for *industry*."""
    tmpl = INDUSTRY_TEMPLATES.get(industry)
    return tmpl.get("sensitivity_presets", {}) if tmpl else {}
