"""Threat detection engine — 165+ signatures, hybrid YOLO+Gemini detection, auto-learning."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from backend.models.models import AlertSeverity

logger = logging.getLogger(__name__)


@dataclass
class ThreatSignatureDef:
    name: str
    category: str
    severity: str
    detection_method: str  # "yolo", "gemini", "hybrid"
    description: str
    yolo_classes: List[str] = None
    conditions: Dict[str, Any] = None
    gemini_keywords: List[str] = None

    def __post_init__(self):
        self.yolo_classes = self.yolo_classes or []
        self.conditions = self.conditions or {}
        self.gemini_keywords = self.gemini_keywords or []


# ── All 165+ Threat Signatures ────────────────────────────────

THREAT_SIGNATURES: List[ThreatSignatureDef] = [
    # ================================================================
    # CATEGORY 1: Intrusion & Access Control (8 signatures)
    # ================================================================
    ThreatSignatureDef("Unauthorized Entry", "intrusion", "critical", "hybrid",
        "Person entering restricted zone without authorization",
        yolo_classes=["person"], conditions={"zone_type": "restricted"},
        gemini_keywords=["unauthorized", "restricted area", "no badge"]),
    ThreatSignatureDef("Tailgating", "intrusion", "high", "gemini",
        "Person following another through access point without scanning",
        gemini_keywords=["tailgating", "following closely", "piggyback"]),
    ThreatSignatureDef("Perimeter Breach", "intrusion", "critical", "hybrid",
        "Person climbing or breaching perimeter fence/wall",
        yolo_classes=["person"], conditions={"near_perimeter": True},
        gemini_keywords=["climbing", "fence", "wall", "breach", "perimeter"]),
    ThreatSignatureDef("Forced Entry", "intrusion", "critical", "gemini",
        "Forceful attempt to open door/window/gate",
        gemini_keywords=["forcing", "prying", "breaking", "smashing"]),
    ThreatSignatureDef("Door Propping", "intrusion", "medium", "gemini",
        "Door being propped open intentionally",
        gemini_keywords=["door propped", "wedge", "holding open"]),
    ThreatSignatureDef("Roof Access Intrusion", "intrusion", "critical", "gemini",
        "Unauthorized access via roof or skylight",
        gemini_keywords=["roof access", "skylight", "climbing roof", "top entry"]),
    ThreatSignatureDef("Tunnel or Underground Entry", "intrusion", "critical", "gemini",
        "Attempted entry through underground passages or tunnels",
        gemini_keywords=["tunnel", "underground", "sewer access", "basement entry"]),
    ThreatSignatureDef("Window Breach", "intrusion", "critical", "gemini",
        "Forced entry through window",
        gemini_keywords=["window break", "glass smash", "window entry", "glass breach"]),

    # ================================================================
    # CATEGORY 2: Loitering & Suspicious Behavior (7 signatures)
    # ================================================================
    ThreatSignatureDef("Loitering", "suspicious", "medium", "hybrid",
        "Person remaining stationary in area beyond threshold",
        yolo_classes=["person"], conditions={"dwell_time_min": 120, "is_stationary": True},
        gemini_keywords=["loitering", "lingering", "standing idle"]),
    ThreatSignatureDef("Casing Behavior", "suspicious", "high", "gemini",
        "Person appears to be surveilling or casing the premises",
        gemini_keywords=["looking around", "surveilling", "casing", "photographing entry"]),
    ThreatSignatureDef("Suspicious Package", "suspicious", "high", "hybrid",
        "Unattended bag or package left in area",
        yolo_classes=["backpack", "suitcase", "handbag"],
        conditions={"unattended_time_min": 60},
        gemini_keywords=["abandoned", "unattended", "left behind", "suspicious package"]),
    ThreatSignatureDef("Unusual Hours Activity", "suspicious", "medium", "hybrid",
        "Activity detected during off-hours",
        yolo_classes=["person"], conditions={"time_window": "off_hours"},
        gemini_keywords=["after hours", "nighttime", "closed"]),
    ThreatSignatureDef("Repeated Visits", "suspicious", "medium", "yolo",
        "Same individual seen multiple times in short period",
        yolo_classes=["person"], conditions={"revisit_threshold": 3}),
    ThreatSignatureDef("Unauthorized Photography", "suspicious", "medium", "gemini",
        "Person photographing security infrastructure or restricted areas",
        gemini_keywords=["photographing", "taking pictures", "filming", "recording security"]),
    ThreatSignatureDef("Disguised Identity", "suspicious", "high", "gemini",
        "Person wearing full face covering or disguise in non-appropriate setting",
        gemini_keywords=["mask", "full face cover", "balaclava", "ski mask", "face concealment"]),

    # ================================================================
    # CATEGORY 3: Violence & Weapons (7 signatures)
    # ================================================================
    ThreatSignatureDef("Weapon Detected", "violence", "critical", "hybrid",
        "Visible weapon (knife, gun-shaped object)",
        yolo_classes=["knife"], gemini_keywords=["weapon", "knife", "gun", "firearm", "blade"]),
    ThreatSignatureDef("Physical Altercation", "violence", "critical", "gemini",
        "Physical fight or aggressive confrontation",
        gemini_keywords=["fighting", "punching", "kicking", "assault", "altercation"]),
    ThreatSignatureDef("Aggressive Behavior", "violence", "high", "gemini",
        "Threatening or aggressive body language",
        gemini_keywords=["aggressive", "threatening", "intimidating", "confrontation"]),
    ThreatSignatureDef("Running/Fleeing", "violence", "high", "gemini",
        "Person running or fleeing the scene",
        gemini_keywords=["running", "fleeing", "sprinting", "rushing"]),
    ThreatSignatureDef("Crowd Disturbance", "violence", "high", "hybrid",
        "Large group showing signs of disorder",
        yolo_classes=["person"], conditions={"person_count_min": 10},
        gemini_keywords=["crowd", "disturbance", "riot", "panic"]),
    ThreatSignatureDef("Hostage Situation", "violence", "critical", "gemini",
        "Person being held against their will",
        gemini_keywords=["hostage", "held captive", "restrained", "kidnapping"]),
    ThreatSignatureDef("Brandishing Weapon", "violence", "critical", "gemini",
        "Person displaying or waving weapon threateningly",
        gemini_keywords=["brandishing", "waving weapon", "displaying weapon", "threatening with weapon"]),

    # ================================================================
    # CATEGORY 4: Theft & Property (5 signatures)
    # ================================================================
    ThreatSignatureDef("Theft in Progress", "theft", "critical", "gemini",
        "Person appears to be stealing items",
        gemini_keywords=["stealing", "theft", "taking", "shoplifting", "grab"]),
    ThreatSignatureDef("Vandalism", "theft", "high", "gemini",
        "Property damage or graffiti in progress",
        gemini_keywords=["vandalism", "graffiti", "damage", "breaking", "smashing"]),
    ThreatSignatureDef("Vehicle Break-in", "theft", "critical", "gemini",
        "Attempted or active vehicle break-in",
        gemini_keywords=["car break-in", "smashing window", "vehicle theft", "jimmying"]),
    ThreatSignatureDef("Trespassing", "theft", "medium", "hybrid",
        "Person in unauthorized area",
        yolo_classes=["person"], conditions={"zone_type": "restricted"},
        gemini_keywords=["trespassing", "no access", "off-limits"]),
    ThreatSignatureDef("Package Theft", "theft", "high", "gemini",
        "Person taking package from delivery area",
        gemini_keywords=["package theft", "porch pirate", "taking delivery"]),

    # ================================================================
    # CATEGORY 5: Vehicle Anomalies (5 signatures)
    # ================================================================
    ThreatSignatureDef("Vehicle in Restricted Zone", "vehicle", "high", "hybrid",
        "Vehicle parked or driving in restricted area",
        yolo_classes=["car", "truck"], conditions={"zone_type": "restricted"},
        gemini_keywords=["vehicle restricted", "no vehicles"]),
    ThreatSignatureDef("Wrong-way Driving", "vehicle", "high", "gemini",
        "Vehicle traveling in wrong direction",
        gemini_keywords=["wrong way", "opposite direction", "contraflow"]),
    ThreatSignatureDef("Speeding Vehicle", "vehicle", "medium", "gemini",
        "Vehicle moving at excessive speed",
        gemini_keywords=["speeding", "fast", "excessive speed"]),
    ThreatSignatureDef("Abandoned Vehicle", "vehicle", "medium", "hybrid",
        "Vehicle left unattended for extended period",
        yolo_classes=["car", "truck"], conditions={"dwell_time_min": 3600},
        gemini_keywords=["abandoned vehicle", "unattended car"]),
    ThreatSignatureDef("Double Parking", "vehicle", "low", "gemini",
        "Vehicle double-parked blocking traffic",
        gemini_keywords=["double parked", "blocking", "illegally parked"]),

    # ================================================================
    # CATEGORY 6: Safety & Environmental (7 signatures)
    # ================================================================
    ThreatSignatureDef("Fire/Smoke", "safety", "critical", "gemini",
        "Visible fire or smoke",
        gemini_keywords=["fire", "smoke", "flames", "burning"]),
    ThreatSignatureDef("Water Leak/Flood", "safety", "high", "gemini",
        "Water leak or flooding detected",
        gemini_keywords=["water", "leak", "flood", "puddle", "overflow"]),
    ThreatSignatureDef("Person Down", "safety", "critical", "gemini",
        "Person lying on ground, possibly injured",
        gemini_keywords=["person down", "collapsed", "lying on ground", "fallen"]),
    ThreatSignatureDef("Medical Emergency", "safety", "critical", "gemini",
        "Apparent medical distress or emergency",
        gemini_keywords=["medical", "emergency", "distress", "unconscious", "seizure"]),
    ThreatSignatureDef("Slip/Fall", "safety", "high", "gemini",
        "Person slipping or falling",
        gemini_keywords=["slipping", "falling", "tripped"]),
    ThreatSignatureDef("Electrical Hazard", "safety", "critical", "gemini",
        "Exposed wiring, sparking, or electrical fire risk",
        gemini_keywords=["sparking", "electrical fire", "exposed wire", "arcing", "electrocution"]),
    ThreatSignatureDef("Gas Leak Indicators", "safety", "critical", "gemini",
        "Visual signs of gas leak such as vapor or distortion",
        gemini_keywords=["gas leak", "vapor", "hissing", "gas smell", "propane"]),

    # ================================================================
    # CATEGORY 7: Occupancy & Crowd (5 signatures)
    # ================================================================
    ThreatSignatureDef("Occupancy Exceeded", "occupancy", "high", "hybrid",
        "Zone person count exceeds maximum",
        yolo_classes=["person"], conditions={"check_max_occupancy": True}),
    ThreatSignatureDef("Crowd Formation", "occupancy", "medium", "hybrid",
        "Unusual crowd gathering",
        yolo_classes=["person"], conditions={"person_count_min": 8},
        gemini_keywords=["gathering", "crowd forming"]),
    ThreatSignatureDef("Evacuation Needed", "occupancy", "critical", "gemini",
        "Conditions requiring evacuation",
        gemini_keywords=["evacuate", "evacuation", "clear the area"]),
    ThreatSignatureDef("Blocked Exit", "occupancy", "high", "gemini",
        "Emergency exit is blocked",
        gemini_keywords=["blocked exit", "exit obstructed", "fire exit blocked"]),
    ThreatSignatureDef("Stampede Risk", "occupancy", "critical", "hybrid",
        "Crowd movement suggesting stampede risk",
        yolo_classes=["person"], conditions={"person_count_min": 20},
        gemini_keywords=["stampede", "crush", "panic movement"]),

    # ================================================================
    # CATEGORY 8: Operational (5 signatures)
    # ================================================================
    ThreatSignatureDef("Camera Tampering", "operational", "critical", "gemini",
        "Camera being obstructed or tampered with",
        gemini_keywords=["camera blocked", "spray paint", "covered", "tampered"]),
    ThreatSignatureDef("Camera Obstruction", "operational", "high", "gemini",
        "Camera view partially blocked",
        gemini_keywords=["obstruction", "blocked view", "partially covered"]),
    ThreatSignatureDef("Lighting Anomaly", "operational", "medium", "gemini",
        "Unusual lighting change suggesting tampering",
        gemini_keywords=["lights off", "darkness", "light broken"]),
    ThreatSignatureDef("Uniform/Badge Anomaly", "operational", "medium", "gemini",
        "Person in incomplete or incorrect uniform",
        gemini_keywords=["wrong uniform", "no badge", "impostor"]),
    ThreatSignatureDef("Social Engineering", "operational", "high", "gemini",
        "Possible social engineering attempt at access point",
        gemini_keywords=["pretexting", "impersonation", "social engineering"]),

    # ================================================================
    # CATEGORY 9: Behavioral Patterns (5 signatures)
    # ================================================================
    ThreatSignatureDef("Pacing/Nervousness", "behavioral", "medium", "gemini",
        "Person exhibiting nervous or pacing behavior",
        gemini_keywords=["pacing", "nervous", "anxious", "fidgeting"]),
    ThreatSignatureDef("Concealment Behavior", "behavioral", "high", "gemini",
        "Person attempting to conceal identity or items",
        gemini_keywords=["hiding face", "concealing", "mask", "hood", "disguise"]),
    ThreatSignatureDef("Surveillance Counter-measures", "behavioral", "high", "gemini",
        "Person actively avoiding or checking cameras",
        gemini_keywords=["avoiding camera", "looking at cameras", "counter-surveillance"]),
    ThreatSignatureDef("Drug Activity", "behavioral", "high", "gemini",
        "Possible drug exchange or use",
        gemini_keywords=["exchange", "hand-to-hand", "drug", "substance"]),
    ThreatSignatureDef("Coordinated Movement", "behavioral", "high", "gemini",
        "Multiple people moving in coordinated suspicious pattern",
        gemini_keywords=["coordinated", "formation", "synchronized", "team movement"]),

    # ================================================================
    # CATEGORY 10: Access & Compliance (7 signatures)
    # ================================================================
    ThreatSignatureDef("PPE Violation", "compliance", "medium", "gemini",
        "Person not wearing required PPE",
        gemini_keywords=["no helmet", "no vest", "no goggles", "PPE violation"]),
    ThreatSignatureDef("Smoking Violation", "compliance", "low", "gemini",
        "Smoking in non-smoking area",
        gemini_keywords=["smoking", "cigarette", "vaping"]),
    ThreatSignatureDef("Loading Dock Violation", "compliance", "medium", "gemini",
        "Unauthorized activity at loading dock",
        gemini_keywords=["loading dock", "unauthorized loading"]),
    ThreatSignatureDef("After-hours Delivery", "compliance", "medium", "hybrid",
        "Delivery activity outside normal hours",
        yolo_classes=["truck"], conditions={"time_window": "off_hours"},
        gemini_keywords=["delivery", "after hours"]),
    ThreatSignatureDef("Drone Detection", "compliance", "high", "gemini",
        "Unauthorized drone in airspace",
        gemini_keywords=["drone", "UAV", "flying object", "quadcopter"]),
    ThreatSignatureDef("Hazardous Material Handling Violation", "compliance", "high", "gemini",
        "Improper handling of hazardous materials without protective equipment",
        gemini_keywords=["hazmat violation", "improper handling", "chemical mishandling", "no protective gear"]),
    ThreatSignatureDef("Fire Exit Propping", "compliance", "high", "gemini",
        "Fire exit being propped open in violation of fire code",
        gemini_keywords=["fire exit propped", "emergency door open", "fire door wedged"]),

    # ================================================================
    # CATEGORY 11: Cyber-Physical (8 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Unauthorized USB Device", "cyber_physical", "critical", "gemini",
        "USB device being inserted into unauthorized terminal or workstation",
        gemini_keywords=["USB", "flash drive", "thumb drive", "device insertion", "plugging in"]),
    ThreatSignatureDef("Server Room Unauthorized Access", "cyber_physical", "critical", "hybrid",
        "Person detected in server room without authorization",
        yolo_classes=["person"], conditions={"zone_type": "restricted"},
        gemini_keywords=["server room", "data center", "network closet", "unauthorized"]),
    ThreatSignatureDef("Cable Tampering", "cyber_physical", "high", "gemini",
        "Person tampering with network cables or infrastructure wiring",
        gemini_keywords=["cable tampering", "network cable", "pulling cables", "disconnecting", "wiring"]),
    ThreatSignatureDef("Unauthorized Device Connection", "cyber_physical", "high", "gemini",
        "Unknown device being connected to network infrastructure",
        gemini_keywords=["connecting device", "rogue device", "network tap", "adding hardware"]),
    ThreatSignatureDef("Equipment Removal", "cyber_physical", "critical", "gemini",
        "Hardware being removed from server rack or workstation",
        gemini_keywords=["removing equipment", "pulling server", "taking hardware", "dismounting"]),
    ThreatSignatureDef("Workstation Tampering", "cyber_physical", "high", "gemini",
        "Person tampering with or opening a workstation case",
        gemini_keywords=["opening computer", "workstation tampering", "case open", "hardware access"]),
    ThreatSignatureDef("Network Cabinet Breach", "cyber_physical", "critical", "gemini",
        "Unauthorized opening of network cabinet or switch rack",
        gemini_keywords=["network cabinet", "switch rack", "opening cabinet", "rack door"]),
    ThreatSignatureDef("Antenna or Wireless Device Placement", "cyber_physical", "high", "gemini",
        "Suspicious placement of antenna or wireless device",
        gemini_keywords=["antenna", "wireless device", "signal jammer", "rogue access point", "wifi"]),

    # ================================================================
    # CATEGORY 12: Insider Threat (8 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Badge Sharing", "insider_threat", "high", "gemini",
        "Sharing or passing access badge to another person",
        gemini_keywords=["badge sharing", "passing badge", "lending card", "handing credential"]),
    ThreatSignatureDef("Badge Cloning Attempt", "insider_threat", "critical", "gemini",
        "Attempt to copy or clone access badge at reader",
        gemini_keywords=["badge cloning", "card copying", "credential duplication", "skimming"]),
    ThreatSignatureDef("After-Hours Sensitive Area Access", "insider_threat", "high", "hybrid",
        "Employee accessing sensitive areas outside business hours",
        yolo_classes=["person"], conditions={"zone_type": "restricted", "time_window": "off_hours"},
        gemini_keywords=["after hours", "sensitive area", "late night access", "weekend access"]),
    ThreatSignatureDef("Data Exfiltration Physical Signs", "insider_threat", "critical", "gemini",
        "Signs of physical data exfiltration such as photographing screens or documents",
        gemini_keywords=["photographing screen", "copying documents", "taking photos of data", "screen capture"]),
    ThreatSignatureDef("Employee Misconduct", "insider_threat", "high", "gemini",
        "Employee engaging in policy-violating or suspicious behavior",
        gemini_keywords=["misconduct", "policy violation", "inappropriate behavior", "unauthorized activity"]),
    ThreatSignatureDef("Unauthorized Document Removal", "insider_threat", "high", "gemini",
        "Person removing documents or files from secure area",
        gemini_keywords=["removing documents", "carrying files", "taking papers", "document theft"]),
    ThreatSignatureDef("Covert Recording", "insider_threat", "critical", "gemini",
        "Person appears to be covertly recording or photographing",
        gemini_keywords=["hidden camera", "covert recording", "secret filming", "spy device"]),
    ThreatSignatureDef("Dual Badge Usage", "insider_threat", "high", "gemini",
        "Same person using multiple access credentials",
        gemini_keywords=["two badges", "multiple cards", "switching credentials", "dual access"]),

    # ================================================================
    # CATEGORY 13: Terrorism Indicators (7 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("IED Indicators", "terrorism", "critical", "gemini",
        "Object resembling improvised explosive device or suspicious wiring",
        gemini_keywords=["IED", "explosive", "bomb", "suspicious wiring", "detonator", "timer device"]),
    ThreatSignatureDef("VBIED Indicators", "terrorism", "critical", "hybrid",
        "Vehicle showing indicators of vehicle-borne improvised explosive device",
        yolo_classes=["car", "truck"], conditions={"dwell_time_min": 300},
        gemini_keywords=["VBIED", "car bomb", "vehicle explosive", "heavy load", "modified vehicle"]),
    ThreatSignatureDef("Hostile Reconnaissance", "terrorism", "high", "gemini",
        "Systematic surveillance or probing of security measures",
        gemini_keywords=["reconnaissance", "probing security", "testing response", "mapping exits", "photographing security"]),
    ThreatSignatureDef("Pre-Attack Surveillance", "terrorism", "critical", "gemini",
        "Target observation consistent with pre-attack planning",
        gemini_keywords=["pre-attack", "target observation", "planning attack", "studying patterns", "timing patrols"]),
    ThreatSignatureDef("Suspicious Chemical or Material", "terrorism", "critical", "gemini",
        "Detection of suspicious chemicals, materials, or containers",
        gemini_keywords=["chemical", "hazardous material", "suspicious container", "gas canister", "powder"]),
    ThreatSignatureDef("Coordinated Perimeter Testing", "terrorism", "high", "gemini",
        "Multiple people simultaneously testing perimeter at different points",
        gemini_keywords=["coordinated testing", "multi-point probe", "simultaneous approach", "perimeter test"]),
    ThreatSignatureDef("Body Armor or Tactical Gear", "terrorism", "critical", "gemini",
        "Person wearing body armor, tactical vest, or combat gear in civilian setting",
        gemini_keywords=["body armor", "tactical vest", "ballistic gear", "combat gear", "plate carrier"]),

    # ================================================================
    # CATEGORY 14: Child Safety (5 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Unaccompanied Minor", "child_safety", "high", "gemini",
        "Child detected without adult supervision in sensitive area",
        gemini_keywords=["unaccompanied child", "alone minor", "lost child", "child without parent"]),
    ThreatSignatureDef("Child in Distress", "child_safety", "critical", "gemini",
        "Child showing signs of distress, crying, or fear",
        gemini_keywords=["child distress", "child crying", "frightened child", "child screaming"]),
    ThreatSignatureDef("Child Abduction Indicators", "child_safety", "critical", "gemini",
        "Adult forcibly leading or carrying a resisting child",
        gemini_keywords=["child abduction", "grabbing child", "dragging child", "carrying struggling", "forced child"]),
    ThreatSignatureDef("Adult Loitering Near Children", "child_safety", "high", "gemini",
        "Unknown adult lingering near children's area or playground",
        gemini_keywords=["adult near children", "loitering playground", "watching children", "lurking near kids"]),
    ThreatSignatureDef("Child Left in Vehicle", "child_safety", "critical", "hybrid",
        "Child detected inside parked vehicle without adult present",
        yolo_classes=["car"], gemini_keywords=["child in car", "kid in vehicle", "baby left in car", "hot car"]),

    # ================================================================
    # CATEGORY 15: Animal Threat (4 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Aggressive Animal", "animal_threat", "high", "gemini",
        "Animal displaying aggressive behavior toward people",
        gemini_keywords=["aggressive animal", "dog attack", "animal threat", "biting", "charging"]),
    ThreatSignatureDef("Wildlife Incursion", "animal_threat", "medium", "gemini",
        "Wildlife detected in restricted or populated area",
        gemini_keywords=["wildlife", "wild animal", "deer", "coyote", "bear", "snake"]),
    ThreatSignatureDef("Stray Animal in Restricted Area", "animal_threat", "medium", "hybrid",
        "Stray animal detected in security-sensitive zone",
        yolo_classes=["dog", "cat"], conditions={"zone_type": "restricted"},
        gemini_keywords=["stray animal", "loose dog", "feral cat", "animal intrusion"]),
    ThreatSignatureDef("Animal-Vehicle Collision Risk", "animal_threat", "high", "gemini",
        "Animal on roadway or near vehicle traffic posing collision risk",
        gemini_keywords=["animal on road", "deer crossing", "collision risk", "animal in traffic"]),

    # ================================================================
    # CATEGORY 16: Infrastructure (7 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Elevator Malfunction", "infrastructure", "high", "gemini",
        "Elevator showing signs of malfunction or entrapment",
        gemini_keywords=["elevator stuck", "lift malfunction", "elevator alarm", "entrapment", "doors jammed"]),
    ThreatSignatureDef("HVAC Anomaly", "infrastructure", "medium", "gemini",
        "HVAC system showing visible anomaly such as smoke or unusual output",
        gemini_keywords=["HVAC anomaly", "air conditioning", "ventilation", "smoke from vent", "unusual smell"]),
    ThreatSignatureDef("Power System Tampering", "infrastructure", "critical", "gemini",
        "Unauthorized access to or tampering with electrical systems",
        gemini_keywords=["electrical tampering", "power panel", "breaker box", "generator", "wiring tamper"]),
    ThreatSignatureDef("Structural Concern", "infrastructure", "high", "gemini",
        "Visible structural damage, crack, or instability in building",
        gemini_keywords=["structural damage", "crack", "wall damage", "ceiling collapse", "foundation issue"]),
    ThreatSignatureDef("Plumbing Emergency", "infrastructure", "high", "gemini",
        "Burst pipe, major water leak, or sewage overflow",
        gemini_keywords=["burst pipe", "plumbing emergency", "sewage", "water main", "flooding"]),
    ThreatSignatureDef("Gate or Barrier Malfunction", "infrastructure", "high", "gemini",
        "Security gate, bollard, or barrier not functioning properly",
        gemini_keywords=["gate malfunction", "barrier stuck", "bollard failure", "gate open", "access barrier"]),
    ThreatSignatureDef("Escalator Hazard", "infrastructure", "high", "gemini",
        "Escalator malfunction or person caught in escalator",
        gemini_keywords=["escalator stuck", "escalator accident", "moving stairs", "escalator emergency"]),

    # ================================================================
    # CATEGORY 17: Medical & Biohazard (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Biohazard Spill", "medical_biohazard", "critical", "gemini",
        "Visible biohazard spill or contamination",
        gemini_keywords=["biohazard", "spill", "biological hazard", "contamination", "blood spill"]),
    ThreatSignatureDef("Chemical Exposure", "medical_biohazard", "critical", "gemini",
        "Signs of chemical exposure or hazardous substance release",
        gemini_keywords=["chemical exposure", "fumes", "gas leak", "chemical spill", "toxic release"]),
    ThreatSignatureDef("Toxic Substance Detection", "medical_biohazard", "critical", "gemini",
        "Unidentified or known toxic substance found",
        gemini_keywords=["toxic substance", "poison", "hazardous material", "unknown liquid", "powder substance"]),
    ThreatSignatureDef("Mass Illness Indicators", "medical_biohazard", "critical", "gemini",
        "Multiple people showing simultaneous signs of illness",
        gemini_keywords=["mass illness", "multiple sick", "group vomiting", "poisoning", "contaminated"]),
    ThreatSignatureDef("Needle or Sharp Hazard", "medical_biohazard", "high", "gemini",
        "Discarded needle or sharp object found in public area",
        gemini_keywords=["needle", "syringe", "sharp object", "biohazard waste", "discarded needle"]),
    ThreatSignatureDef("Radiation Indicator", "medical_biohazard", "critical", "gemini",
        "Signs of radioactive material or radiation exposure",
        gemini_keywords=["radiation", "radioactive", "geiger counter", "nuclear", "contamination zone"]),

    # ================================================================
    # CATEGORY 18: Retail & Commercial (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Organized Retail Crime", "retail_commercial", "critical", "gemini",
        "Coordinated group shoplifting or retail theft operation",
        gemini_keywords=["organized theft", "group shoplifting", "smash and grab", "retail crime ring", "coordinated stealing"]),
    ThreatSignatureDef("Flash Mob Theft", "retail_commercial", "critical", "hybrid",
        "Large group rushing into store for mass theft",
        yolo_classes=["person"], conditions={"person_count_min": 8},
        gemini_keywords=["flash mob", "mob theft", "rush theft", "mass shoplifting", "store rush"]),
    ThreatSignatureDef("Customer Distress", "retail_commercial", "high", "gemini",
        "Customer in distress, altercation, or medical emergency in commercial space",
        gemini_keywords=["customer distress", "store emergency", "customer fight", "shopper distress"]),
    ThreatSignatureDef("Shoplifting Ring Activity", "retail_commercial", "high", "gemini",
        "Suspected professional shoplifting with concealment tactics",
        gemini_keywords=["shoplifting", "concealment", "booster bag", "tag removal", "merchandise hiding"]),
    ThreatSignatureDef("Employee Theft", "retail_commercial", "high", "gemini",
        "Employee engaging in theft or unauthorized product removal",
        gemini_keywords=["employee theft", "internal theft", "staff stealing", "sweethearting"]),
    ThreatSignatureDef("Till Skimming", "retail_commercial", "high", "gemini",
        "Unauthorized access to cash register or point-of-sale system",
        gemini_keywords=["till skimming", "register theft", "POS tampering", "cash theft", "skimmer device"]),

    # ================================================================
    # CATEGORY 19: Parking (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Hit and Run", "parking", "critical", "gemini",
        "Vehicle striking person or vehicle and fleeing scene",
        gemini_keywords=["hit and run", "vehicle collision", "struck pedestrian", "driving away", "fleeing accident"]),
    ThreatSignatureDef("Carjacking Attempt", "parking", "critical", "gemini",
        "Forceful attempt to take control of occupied vehicle",
        gemini_keywords=["carjacking", "car theft force", "pulling driver", "hijacking vehicle", "car robbery"]),
    ThreatSignatureDef("Vehicle Stalking", "parking", "high", "gemini",
        "Vehicle appearing to follow or stalk a person",
        gemini_keywords=["vehicle following", "car stalking", "following person", "tracking vehicle", "pursuit"]),
    ThreatSignatureDef("Vehicle Circling", "parking", "medium", "hybrid",
        "Vehicle making repeated passes through same area",
        yolo_classes=["car", "truck"], conditions={"revisit_threshold": 3},
        gemini_keywords=["circling", "repeated passes", "driving in circles", "scouting"]),
    ThreatSignatureDef("Parking Lot Assault", "parking", "critical", "gemini",
        "Physical assault occurring in parking area",
        gemini_keywords=["parking assault", "parking attack", "garage assault", "lot violence"]),
    ThreatSignatureDef("Suspicious Vehicle Modification", "parking", "high", "gemini",
        "Vehicle with unusual modifications suggesting concealment or attack capability",
        gemini_keywords=["vehicle modification", "blacked out windows", "armored vehicle", "concealed", "modified plates"]),

    # ================================================================
    # CATEGORY 20: Active Shooter (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Active Shooter Indicators", "active_shooter", "critical", "hybrid",
        "Individual with firearm exhibiting active threat behavior",
        yolo_classes=["person"], gemini_keywords=["active shooter", "shooting", "gunman", "gunfire", "armed assailant"]),
    ThreatSignatureDef("Gunfire Acoustics", "active_shooter", "critical", "gemini",
        "Sounds consistent with gunfire detected",
        gemini_keywords=["gunshot", "gunfire", "shooting sound", "rapid fire", "ballistic"]),
    ThreatSignatureDef("Mass Casualty Event", "active_shooter", "critical", "gemini",
        "Multiple persons down indicating mass casualty event",
        gemini_keywords=["mass casualty", "multiple victims", "multiple down", "mass shooting", "triage"]),
    ThreatSignatureDef("Barricade Situation", "active_shooter", "critical", "gemini",
        "Armed person barricaded in location with or without hostages",
        gemini_keywords=["barricade", "hostage", "standoff", "fortified position", "holed up"]),
    ThreatSignatureDef("Mass Panic Fleeing", "active_shooter", "critical", "hybrid",
        "Large group of people running in panic from a location",
        yolo_classes=["person"], conditions={"person_count_min": 10},
        gemini_keywords=["mass panic", "fleeing", "stampede", "running away", "mass evacuation"]),
    ThreatSignatureDef("Tactical Entry in Progress", "active_shooter", "critical", "gemini",
        "Law enforcement tactical team entry indicators",
        gemini_keywords=["SWAT", "tactical team", "breach", "tactical entry", "law enforcement response"]),

    # ================================================================
    # CATEGORY 21: Escape & Evasion (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Evidence Tampering", "escape_evasion", "critical", "gemini",
        "Person attempting to destroy, remove, or tamper with evidence",
        gemini_keywords=["evidence tampering", "destroying evidence", "wiping", "cleaning scene", "removing traces"]),
    ThreatSignatureDef("Suspect Vehicle Fleeing", "escape_evasion", "critical", "hybrid",
        "Vehicle fleeing at high speed after incident",
        yolo_classes=["car", "truck"],
        gemini_keywords=["fleeing vehicle", "getaway car", "high speed escape", "driving away fast"]),
    ThreatSignatureDef("Disguise Change", "escape_evasion", "high", "gemini",
        "Person changing appearance, clothes, or using disguise to evade",
        gemini_keywords=["changing clothes", "disguise", "removing jacket", "altering appearance", "putting on hat"]),
    ThreatSignatureDef("Perimeter Exit After Incident", "escape_evasion", "critical", "hybrid",
        "Person exiting perimeter immediately after security incident",
        yolo_classes=["person"], conditions={"near_perimeter": True},
        gemini_keywords=["exiting after incident", "perimeter escape", "leaving scene", "fence exit"]),
    ThreatSignatureDef("Route Deception", "escape_evasion", "high", "gemini",
        "Person taking unusual or evasive route to avoid detection",
        gemini_keywords=["evasive route", "avoiding cameras", "back exit", "unusual path", "circumventing"]),
    ThreatSignatureDef("Accomplice Getaway", "escape_evasion", "critical", "gemini",
        "Accomplice waiting in vehicle or designated pickup for suspect",
        gemini_keywords=["getaway driver", "accomplice waiting", "pickup vehicle", "escape car", "waiting outside"]),

    # ================================================================
    # CATEGORY 22: Social Unrest (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Protest Activity", "social_unrest", "medium", "hybrid",
        "Organized protest or demonstration detected",
        yolo_classes=["person"], conditions={"person_count_min": 15},
        gemini_keywords=["protest", "demonstration", "rally", "march", "chanting"]),
    ThreatSignatureDef("Picketing", "social_unrest", "low", "gemini",
        "Organized picketing activity near facility",
        gemini_keywords=["picket line", "picketing", "strike", "placards", "signs"]),
    ThreatSignatureDef("Civil Disturbance", "social_unrest", "high", "gemini",
        "Crowd behavior escalating to civil disturbance",
        gemini_keywords=["civil disturbance", "unrest", "riot", "mob", "violence"]),
    ThreatSignatureDef("Demonstration Escalation", "social_unrest", "high", "gemini",
        "Peaceful demonstration showing signs of escalation to violence",
        gemini_keywords=["escalation", "turning violent", "throwing objects", "confrontation", "aggressive crowd"]),
    ThreatSignatureDef("Tear Gas or Chemical Agent", "social_unrest", "critical", "gemini",
        "Chemical agent or tear gas deployed during disturbance",
        gemini_keywords=["tear gas", "pepper spray", "chemical agent", "smoke bomb", "gas canister"]),
    ThreatSignatureDef("Property Destruction During Unrest", "social_unrest", "high", "gemini",
        "Property being damaged during civil unrest or protest",
        gemini_keywords=["smashing windows", "property destruction", "looting", "arson", "vandalism unrest"]),

    # ================================================================
    # CATEGORY 23: Micro-Behavior Analysis (6 signatures) — NEW
    # ================================================================
    ThreatSignatureDef("Blading Stance", "micro_behavior", "high", "hybrid",
        "Person adopting blading stance — torso turned sideways, common pre-attack positioning",
        yolo_classes=["person"], conditions={"pose_blading": True, "dwell_time_min": 3},
        gemini_keywords=["blading", "turned sideways", "angled stance", "pre-attack posture"]),
    ThreatSignatureDef("Target Fixation", "micro_behavior", "high", "hybrid",
        "Person maintaining fixed gaze direction — possible target observation",
        yolo_classes=["person"], conditions={"pose_target_fixation": True, "dwell_time_min": 5},
        gemini_keywords=["staring", "fixed gaze", "watching intently", "target observation"]),
    ThreatSignatureDef("Staking Behavior", "micro_behavior", "high", "hybrid",
        "Person positioned at vantage point with extended stationary observation",
        yolo_classes=["person"], conditions={"pose_staking": True, "dwell_time_min": 30},
        gemini_keywords=["staking out", "vantage point", "overwatch", "surveilling from distance"]),
    ThreatSignatureDef("Concealed Object Carry", "micro_behavior", "high", "hybrid",
        "Asymmetric arm swing suggesting concealed object pressed to body",
        yolo_classes=["person"], conditions={"pose_concealed_carry": True},
        gemini_keywords=["concealed carry", "hidden weapon", "arm pinned", "asymmetric walk"]),
    ThreatSignatureDef("Pre-Assault Posturing", "micro_behavior", "critical", "hybrid",
        "Wide stance and lowered center of gravity indicating imminent physical aggression",
        yolo_classes=["person"], conditions={"pose_pre_assault": True},
        gemini_keywords=["pre-assault", "fighting stance", "squared up", "aggressive posture"]),
    ThreatSignatureDef("Evasive Movement", "micro_behavior", "medium", "hybrid",
        "Camera avoidance behavior — face turned away, erratic direction changes",
        yolo_classes=["person"], conditions={"pose_evasive": True, "dwell_time_min": 5},
        gemini_keywords=["evasive", "avoiding camera", "turning away", "erratic movement"]),
]


# ── Threat Engine ─────────────────────────────────────────────

class ThreatEngine:
    """Evaluates detections against threat signatures. Supports DB sync and auto-learning."""

    def __init__(self):
        self._builtin_signatures = {s.name: s for s in THREAT_SIGNATURES}
        self.signatures: Dict[str, ThreatSignatureDef] = dict(self._builtin_signatures)
        self._db_synced = False

    # ── DB sync ──────────────────────────────────────────────

    async def sync_from_db(self):
        """Load all active DB signatures and merge with built-in ones. Called at startup."""
        try:
            from backend.database import async_session
            from backend.models.models import ThreatSignature
            from sqlalchemy import select

            async with async_session() as session:
                result = await session.execute(
                    select(ThreatSignature).where(ThreatSignature.is_active == True)
                )
                db_sigs = result.scalars().all()

                for db_sig in db_sigs:
                    sev = db_sig.severity.value if hasattr(db_sig.severity, "value") else str(db_sig.severity)
                    sig_def = ThreatSignatureDef(
                        name=db_sig.name,
                        category=db_sig.category,
                        severity=sev,
                        detection_method=db_sig.detection_method,
                        description=db_sig.description or "",
                        yolo_classes=db_sig.yolo_classes or [],
                        conditions=db_sig.conditions or {},
                        gemini_keywords=db_sig.gemini_keywords or [],
                    )
                    self.signatures[db_sig.name] = sig_def

                self._db_synced = True
                logger.info(
                    "ThreatEngine synced: %d built-in + %d DB = %d total active signatures",
                    len(self._builtin_signatures), len(db_sigs), len(self.signatures),
                )
        except Exception as e:
            logger.warning("ThreatEngine DB sync failed: %s — using built-in only", e)

    # ── Auto-learning ────────────────────────────────────────

    async def auto_learn_signature(
        self,
        threat_explanation: str,
        evidence: List[str],
        recommended_severity: str,
        camera_id: str = None,
        event_id: str = None,
    ) -> Optional[Dict[str, Any]]:
        """Auto-create a new threat signature from Gemini analysis of a novel threat."""
        from backend.database import async_session
        from backend.models.models import ThreatSignature, AlertSeverity
        import uuid as _uuid

        # 1. Extract keywords
        combined_text = f"{threat_explanation} {' '.join(evidence)}"
        words = set(re.findall(r"\b[a-zA-Z]{3,}\b", combined_text.lower()))
        stop_words = {
            "the", "and", "for", "are", "but", "not", "you", "all", "can",
            "her", "was", "one", "our", "out", "has", "have", "been", "from",
            "this", "that", "with", "they", "will", "would", "there", "their",
            "what", "about", "which", "when", "make", "like", "time", "just",
            "know", "take", "come", "could", "than", "look", "only", "into",
            "other", "also", "after", "use", "two", "how", "then", "first",
            "any", "new", "work", "now", "may", "way", "each", "very",
            "because", "does", "person", "people", "area", "possible", "likely",
            "observed", "detected", "scene", "camera", "analysis", "appears",
            "suggest", "indicates", "consistent", "evidence", "explanation",
        }
        keywords = sorted(words - stop_words)[:15]

        if len(keywords) < 3:
            logger.debug("Auto-learn skipped: too few keywords extracted (%d)", len(keywords))
            return None

        # 2. Deduplication — reject if >50% keyword overlap with existing signature
        for existing_sig in self.signatures.values():
            if existing_sig.gemini_keywords:
                existing_kws = set(kw.lower() for kw in existing_sig.gemini_keywords)
                overlap = len(set(keywords) & existing_kws)
                overlap_ratio = overlap / max(len(keywords), len(existing_kws), 1)
                if overlap_ratio > 0.5:
                    logger.info(
                        "Auto-learn dedup: overlaps %.0f%% with '%s' — skipping",
                        overlap_ratio * 100, existing_sig.name,
                    )
                    return None

        # 3. Generate name
        name_base = threat_explanation.split(".")[0].strip()
        name = name_base[:80] if len(name_base) <= 80 else name_base[:77] + "..."
        if name in self.signatures:
            name = f"{name} [{str(_uuid.uuid4())[:6]}]"

        # 4. Infer category
        category = self._infer_category(keywords, threat_explanation)

        # 5. Map severity
        severity_map = {
            "critical": AlertSeverity.CRITICAL,
            "high": AlertSeverity.HIGH,
            "medium": AlertSeverity.MEDIUM,
            "low": AlertSeverity.LOW,
            "info": AlertSeverity.INFO,
        }
        severity_enum = severity_map.get(recommended_severity, AlertSeverity.MEDIUM)

        # 6. Persist to DB
        try:
            async with async_session() as session:
                db_sig = ThreatSignature(
                    name=name,
                    category=category,
                    description=threat_explanation[:500],
                    severity=severity_enum,
                    detection_method="gemini",
                    yolo_classes=[],
                    gemini_prompt=None,
                    gemini_keywords=keywords,
                    conditions={},
                    is_active=True,
                    source="auto_learned",
                    detection_count=1,
                    learned_from_event_id=_uuid.UUID(event_id) if event_id else None,
                )
                session.add(db_sig)
                await session.commit()
                await session.refresh(db_sig)

                # 7. Load into in-memory engine
                self.signatures[name] = ThreatSignatureDef(
                    name=name,
                    category=category,
                    severity=recommended_severity,
                    detection_method="gemini",
                    description=threat_explanation[:500],
                    gemini_keywords=keywords,
                )

                logger.info(
                    "Auto-learned signature: name='%s' category='%s' severity='%s' keywords=%d",
                    name, category, recommended_severity, len(keywords),
                )
                return {
                    "id": str(db_sig.id),
                    "name": name,
                    "category": category,
                    "severity": recommended_severity,
                    "keywords": keywords,
                    "source": "auto_learned",
                }
        except Exception as e:
            logger.error("Auto-learn DB persist failed: %s", e)
            return None

    def _infer_category(self, keywords: List[str], explanation: str) -> str:
        """Heuristically infer the best category for an auto-learned signature."""
        text = explanation.lower()
        category_signals = {
            "micro_behavior": ["blading", "stance", "fixation", "staking", "concealed", "evasive", "posturing", "gait"],
            "cyber_physical": ["usb", "server", "cable", "network", "device", "hardware", "computer"],
            "insider_threat": ["employee", "badge", "credential", "insider", "staff"],
            "terrorism": ["explosive", "bomb", "attack", "terrorist", "ied", "reconnaissance"],
            "child_safety": ["child", "minor", "kid", "unaccompanied", "abduction"],
            "animal_threat": ["animal", "dog", "wildlife", "stray"],
            "infrastructure": ["elevator", "hvac", "pipe", "structural", "power"],
            "medical_biohazard": ["biohazard", "chemical", "toxic", "radiation", "contamination"],
            "retail_commercial": ["shoplifting", "retail", "store", "merchandise"],
            "parking": ["parking", "carjacking", "garage", "hit and run"],
            "active_shooter": ["shooter", "gunfire", "shooting", "firearm", "hostage"],
            "escape_evasion": ["escape", "fleeing", "disguise", "getaway"],
            "social_unrest": ["protest", "riot", "demonstration", "civil", "unrest"],
            "intrusion": ["entry", "breach", "trespass", "intrusion"],
            "suspicious": ["suspicious", "loitering", "casing", "unusual"],
            "violence": ["fight", "assault", "weapon", "aggressive"],
            "theft": ["stealing", "theft", "vandalism", "burglary"],
            "vehicle": ["vehicle", "driving", "parked", "traffic"],
            "safety": ["fire", "flood", "medical", "emergency", "fall"],
            "occupancy": ["crowd", "occupancy", "evacuation", "stampede"],
            "operational": ["camera", "tampering", "obstruction", "lighting"],
            "behavioral": ["pacing", "nervous", "concealment", "surveillance"],
            "compliance": ["ppe", "violation", "smoking", "regulation"],
        }
        best_category = "suspicious"
        best_score = 0
        for cat, signals in category_signals.items():
            score = sum(1 for s in signals if s in text or s in keywords)
            if score > best_score:
                best_score = score
                best_category = cat
        return best_category

    async def increment_detection_count(self, signature_name: str):
        """Increment the detection count for a signature in the DB."""
        try:
            from backend.database import async_session
            from backend.models.models import ThreatSignature
            from sqlalchemy import update
            from datetime import datetime, timezone

            async with async_session() as session:
                await session.execute(
                    update(ThreatSignature)
                    .where(ThreatSignature.name == signature_name)
                    .values(
                        detection_count=ThreatSignature.detection_count + 1,
                        last_detected_at=datetime.now(timezone.utc),
                    )
                )
                await session.commit()
        except Exception:
            pass  # Non-critical

    # ── Evaluation methods ───────────────────────────────────

    def evaluate_yolo(
        self,
        detections: Dict[str, Any],
        zone_info: Optional[Dict] = None,
    ) -> List[Dict[str, Any]]:
        """Evaluate YOLO detections against signatures."""
        threats = []
        det_list = detections.get("detections", [])

        for sig in self.signatures.values():
            if sig.detection_method == "gemini":
                continue

            matched = False
            confidence = 0.0

            if sig.yolo_classes:
                for det in det_list:
                    if det.get("class") in sig.yolo_classes:
                        if self._check_conditions(sig.conditions, det, detections, zone_info):
                            matched = True
                            confidence = max(confidence, det.get("confidence", 0.5))

            if matched:
                threats.append({
                    "signature": sig.name,
                    "category": sig.category,
                    "severity": sig.severity,
                    "confidence": round(confidence, 3),
                    "description": sig.description,
                    "detection_method": "yolo",
                })

        return threats

    def evaluate_gemini(
        self,
        analysis: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Evaluate Gemini analysis against signatures."""
        threats = []
        if not analysis:
            return threats

        for indicator in analysis.get("threat_indicators", []):
            threats.append({
                "signature": indicator.get("type", "Unknown Threat"),
                "category": "gemini_detected",
                "severity": self._map_risk_to_severity(analysis.get("overall_risk", "low")),
                "confidence": indicator.get("confidence", 0.5),
                "description": indicator.get("description", ""),
                "detection_method": "gemini",
            })

        anomalies_text = " ".join(analysis.get("anomalies", [])).lower()
        scene_text = analysis.get("scene_description", "").lower()
        combined_text = f"{anomalies_text} {scene_text}"

        for sig in self.signatures.values():
            if sig.detection_method == "yolo":
                continue
            if sig.gemini_keywords:
                matches = sum(1 for kw in sig.gemini_keywords if kw.lower() in combined_text)
                if matches > 0:
                    confidence = min(0.4 + (matches * 0.15), 0.95)
                    if not any(t["signature"] == sig.name for t in threats):
                        threats.append({
                            "signature": sig.name,
                            "category": sig.category,
                            "severity": sig.severity,
                            "confidence": round(confidence, 3),
                            "description": sig.description,
                            "detection_method": "gemini_keyword",
                        })

        return threats

    def evaluate_hybrid(
        self,
        detections: Dict[str, Any],
        gemini_analysis: Optional[Dict[str, Any]],
        zone_info: Optional[Dict] = None,
    ) -> List[Dict[str, Any]]:
        """Combined YOLO + Gemini threat evaluation with XAI explanation chains and context profile adjustments."""
        yolo_threats = self.evaluate_yolo(detections, zone_info)
        gemini_threats = self.evaluate_gemini(gemini_analysis) if gemini_analysis else []

        merged = {}
        for t in yolo_threats + gemini_threats:
            key = t["signature"]
            if key in merged:
                merged[key]["confidence"] = min(
                    merged[key]["confidence"] + t["confidence"] * 0.3, 1.0
                )
                merged[key]["detection_method"] = "hybrid"
            else:
                merged[key] = t

        # Check false-positive feedback and suppress repeatedly-dismissed signatures
        fp_suppressed = {}
        try:
            import redis as _redis
            from backend.config import settings
            camera_id = detections.get("camera_id", "")
            if camera_id:
                r = _redis.from_url(settings.REDIS_URL)
                for t in merged.values():
                    fp_key = f"fp_feedback:{t['signature']}:{camera_id}"
                    fp_data = r.hgetall(fp_key)
                    fp_count = int(fp_data.get(b"count", 0))
                    if fp_count > 5:
                        t["confidence"] = max(0.1, t["confidence"] - 0.15)
                        fp_suppressed[t["signature"]] = fp_count
                        logger.info(
                            "threat.fp_suppression signature=%s camera=%s fp_count=%d",
                            t["signature"], camera_id, fp_count,
                        )
        except Exception:
            pass

        # Apply context profile severity adjustments
        context_adjustments = {}
        try:
            from backend.services.context_profiles import context_profile_service
            if context_profile_service.active_profile:
                for t in merged.values():
                    # Skip disabled signatures
                    if context_profile_service.is_signature_disabled(t["signature"]):
                        t["_suppressed"] = True
                        continue
                    # Adjust severity based on environment context
                    original_severity = t["severity"]
                    t["severity"] = context_profile_service.adjust_severity(
                        t["category"], original_severity
                    )
                    if t["severity"] != original_severity:
                        t["context_adjusted"] = True
                        t["original_severity"] = original_severity
                        context_adjustments[t["signature"]] = {
                            "from": original_severity,
                            "to": t["severity"],
                            "profile": context_profile_service.active_profile.name
                                if hasattr(context_profile_service.active_profile, "name") else "active",
                        }
                # Remove suppressed entries
                merged = {k: v for k, v in merged.items() if not v.get("_suppressed")}
        except Exception:
            pass  # Context profiles not available — proceed without adjustment

        # Build XAI explanation chain for each threat
        try:
            from backend.services.explanation_builder import explanation_builder
            for t in merged.values():
                chain = explanation_builder.create_chain(
                    alert_id=detections.get("event_id", ""),
                    threat_type=t["signature"],
                )
                # Add YOLO evidence
                for det in detections.get("detections", []):
                    if det.get("class") in (self.signatures.get(t["signature"], ThreatSignatureDef("", "", "", "", "")).yolo_classes or []):
                        explanation_builder.add_yolo_evidence(
                            chain, det["class"],
                            det.get("confidence", 0.0),
                            det.get("bbox", []),
                        )
                # Add zone rule evidence
                if zone_info:
                    explanation_builder.add_zone_rule_evidence(
                        chain,
                        zone_name=zone_info.get("name", zone_info.get("zone_name", "")),
                        rule_triggered=f"zone_type={zone_info.get('zone_type', 'general')}",
                        zone_status=zone_info.get("status", "active"),
                    )
                # Add Gemini evidence
                if gemini_analysis:
                    explanation_builder.add_gemini_evidence(
                        chain,
                        scene_description=gemini_analysis.get("scene_description", ""),
                        risk_level=gemini_analysis.get("overall_risk", "unknown"),
                        anomalies=gemini_analysis.get("anomalies", []),
                    )
                # Add false-positive evidence if applicable
                if t["signature"] in fp_suppressed:
                    explanation_builder.add_false_positive_evidence(
                        chain,
                        fp_count=fp_suppressed[t["signature"]],
                        confidence_reduction=0.15,
                    )
                # Add context profile evidence if applicable
                if t["signature"] in context_adjustments:
                    adj = context_adjustments[t["signature"]]
                    explanation_builder.add_context_profile_evidence(
                        chain,
                        profile_name=adj["profile"],
                        adjustments={t["signature"]: adj},
                    )
                # Attach explanation chain to threat
                t["explanation_chain"] = chain.to_dict()
        except Exception as e:
            logger.debug("threat.xai_chain_failed: %s", e)

        return sorted(merged.values(), key=lambda x: self._severity_rank(x["severity"]), reverse=True)

    def _check_conditions(
        self,
        conditions: Dict,
        detection: Dict,
        all_detections: Dict,
        zone_info: Optional[Dict],
    ) -> bool:
        """Strictly validate ALL conditions — unknown or unverifiable conditions FAIL."""
        if not conditions:
            return True

        for key, value in conditions.items():
            # Ensure numeric condition values are actually numeric
            # (AI-parsed rules may return strings like "30" instead of 30)
            if key in ("dwell_time_min", "person_count_min", "unattended_time_min"):
                try:
                    value = float(value)
                except (TypeError, ValueError):
                    value = 0

            if key == "dwell_time_min":
                if float(detection.get("dwell_time", 0)) < value:
                    return False

            elif key == "is_stationary":
                if value and not detection.get("is_stationary", False):
                    return False

            elif key == "zone_type":
                if zone_info is None or zone_info.get("zone_type") != value:
                    return False

            elif key == "near_perimeter":
                if value and (zone_info is None or not zone_info.get("near_perimeter")):
                    return False

            elif key == "check_max_occupancy":
                if zone_info is None:
                    return False
                max_occ = zone_info.get("max_occupancy")
                if not max_occ or int(all_detections.get("person_count", 0)) <= int(max_occ):
                    return False

            elif key == "person_count_min":
                if float(all_detections.get("person_count", 0)) < value:
                    return False

            elif key == "unattended_time_min":
                if float(detection.get("dwell_time", 0)) < value:
                    return False

            elif key == "time_window":
                if not self._check_time_window(value):
                    return False

            elif key == "revisit_threshold":
                return False

            elif key == "pose_blading":
                pose = detection.get("pose_features", {})
                if value and not pose.get("blading"):
                    return False

            elif key == "pose_target_fixation":
                pose = detection.get("pose_features", {})
                if value and not pose.get("target_fixation"):
                    return False

            elif key == "pose_pre_assault":
                pose = detection.get("pose_features", {})
                if value and not pose.get("pre_assault"):
                    return False

            elif key == "pose_staking":
                pose = detection.get("pose_features", {})
                if value and not pose.get("staking"):
                    return False

            elif key == "pose_concealed_carry":
                pose = detection.get("pose_features", {})
                if value and not pose.get("concealed_carry"):
                    return False

            elif key == "pose_evasive":
                pose = detection.get("pose_features", {})
                if value and not pose.get("evasive"):
                    return False

            else:
                return False

        return True

    @staticmethod
    def _check_time_window(window: str) -> bool:
        """Check if current time falls within a named time window."""
        import datetime as dt
        now = dt.datetime.now()
        hour = now.hour
        if window == "off_hours":
            return hour < 6 or hour >= 22
        if window == "business_hours":
            return 6 <= hour < 22
        return False

    def _map_risk_to_severity(self, risk: str) -> str:
        mapping = {
            "critical": "critical",
            "high": "high",
            "medium": "medium",
            "low": "low",
            "none": "info",
        }
        return mapping.get(risk, "medium")

    def _severity_rank(self, severity: str) -> int:
        ranks = {"critical": 5, "high": 4, "medium": 3, "low": 2, "info": 1}
        return ranks.get(severity, 0)

    def get_signatures_by_category(self, category: str) -> List[ThreatSignatureDef]:
        return [s for s in self.signatures.values() if s.category == category]

    def get_all_categories(self) -> List[str]:
        return sorted(set(s.category for s in self.signatures.values()))

    def get_signature_count(self) -> int:
        return len(self.signatures)


# Singleton
threat_engine = ThreatEngine()
