# SENTINEL AI

**Agentic Physical Security Intelligence Platform**

Sentinel AI is a production-grade, full-stack security operations platform that unifies real-time video analytics, multi-modal threat detection, autonomous AI agents, and forensic investigation into a single Security Operations Center (SOC). The system processes live camera feeds through a layered perception-reasoning-action agent architecture, correlates events across cameras, sensors, and access control systems, and provides operators with an intelligent command interface for physical security management.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Architecture Diagram](#architecture-diagram)
3. [Technology Stack](#technology-stack)
4. [Project Structure](#project-structure)
5. [Agent System](#agent-system)
6. [Backend Services](#backend-services)
7. [API Surface](#api-surface)
8. [Frontend Application](#frontend-application)
9. [Database Schema](#database-schema)
10. [Threat Detection Engine](#threat-detection-engine)
11. [Integration Layer](#integration-layer)
12. [Quick Start](#quick-start)
13. [Configuration](#configuration)
14. [RBAC and Authentication](#rbac-and-authentication)
15. [Deployment](#deployment)

---

## System Architecture

Sentinel AI follows a layered architecture with four principal tiers:

**Data Ingestion Layer**: Camera feeds (RTSP, USB, ONVIF), IoT sensors (MQTT, Modbus), PACS card readers, alarm panels, and environmental monitors continuously stream data into the platform.

**Perception Layer**: YOLOv8 performs real-time object detection with ByteTrack multi-object tracking. CLIP generates visual embeddings for semantic search. Audio classifiers detect gunshots, glass breaking, and screams. Each feed is processed at up to 15 FPS with 30-frame ring buffers per camera.

**Reasoning Layer**: Google Gemini provides scene understanding, forensic analysis, and natural language threat assessment. A threat engine with 165+ hybrid signatures (YOLO + Gemini keyword matching) classifies detections. Baseline learning services establish per-zone, per-time-slot normality profiles. Causal reasoning and counterfactual engines analyze incident chains.

**Action Layer**: Autonomous response services trigger alerts, lockdowns, dispatch assignments, and multi-channel notifications. A human-in-the-loop (HITL) approval system gates high-impact actions. All actions are audited with full chain-of-custody logging.

A central supervisor agent (Sentinel Cortex) orchestrates 16+ specialized agents across these tiers, coordinating perception, analysis, and response through Redis Pub/Sub channels.

---

## Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                              SENTINEL AI PLATFORM                                 |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  +---------------------------+    +---------------------------+                   |
|  |     DATA SOURCES          |    |     EXTERNAL SYSTEMS      |                   |
|  |                           |    |                           |                   |
|  |  RTSP/USB/ONVIF Cameras   |    |  PACS (Card Readers)      |                   |
|  |  MQTT/Modbus Sensors      |    |  Alarm Panels             |                   |
|  |  Audio Microphones        |    |  SIEM (Splunk/ELK)        |                   |
|  |  Environmental Monitors   |    |  Building Mgmt Systems    |                   |
|  |  Body Cameras             |    |  Intercom / PA Systems    |                   |
|  +------------+--------------+    +------------+--------------+                   |
|               |                                |                                  |
|               v                                v                                  |
|  +------------------------------------------------------------------------+       |
|  |                         FASTAPI BACKEND (async)                        |       |
|  |                                                                        |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  |  | VIDEO CAPTURE     |  | YOLO DETECTOR     |  | GEMINI PROVIDERS   |  |       |
|  |  | Ring buffers (30f)|  | YOLOv8n + ByteTrack|  | Flash (realtime)  |  |       |
|  |  | RTSP reconnection |  | 80+ object classes |  | Pro (forensics)   |  |       |
|  |  | Up to 16 cameras  |  | Dwell/trajectory  |  | 10 req/min limit  |  |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  |                                                                        |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  |  | CLIP PIPELINE     |  | THREAT ENGINE     |  | ALERT MANAGER      |  |       |
|  |  | ViT-B-32 embeddings|  | 165+ signatures  |  | Dedup (30s window) |  |       |
|  |  | Semantic search   |  | YOLO+Gemini hybrid|  | Auto-escalation    |  |       |
|  |  | Frame similarity  |  | Auto-learning     |  | Status transitions |  |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  |                                                                        |       |
|  |  +------------------------------------------------------------------+  |       |
|  |  |                    AGENT ORCHESTRATION LAYER                      |  |       |
|  |  |                                                                  |  |       |
|  |  |  SUPERVISOR          PERCEPTION           REASONING              |  |       |
|  |  |  +--------------+   +--------------+     +--------------+       |  |       |
|  |  |  |Sentinel      |   |SentinelEye   |     |ThreatAnalyst |       |  |       |
|  |  |  |Cortex        |   |PatrolAgent   |     |Investigator  |       |  |       |
|  |  |  |              |   |CrowdMonitor  |     |Correlator    |       |  |       |
|  |  |  |Orchestrates  |   |LPRAgent      |     |ReIDAgent     |       |  |       |
|  |  |  |all agents,   |   |AudioAgent    |     |GhostTracer   |       |  |       |
|  |  |  |resolves      |   |TamperAgent   |     |CompanionAgent|       |  |       |
|  |  |  |conflicts,    |   |PPEAgent      |     +--------------+       |  |       |
|  |  |  |shift handoff |   |EnvAgent      |                            |  |       |
|  |  |  +--------------+   |MicroBehavior |     ACTION                  |  |       |
|  |  |                     |AnomalyDetect |     +--------------+       |  |       |
|  |  |                     +--------------+     |ResponseAction|       |  |       |
|  |  |                                          |ReportAgent   |       |  |       |
|  |  |  Communication: Redis Pub/Sub            |DispatchAgent |       |  |       |
|  |  |  Memory: Short-term (Redis) +            |ComplianceAgt |       |  |       |
|  |  |          Long-term (PostgreSQL)          +--------------+       |  |       |
|  |  +------------------------------------------------------------------+  |       |
|  |                                                                        |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  |  | REST API (80+)    |  | WEBSOCKET SERVER  |  | CELERY WORKERS     |  |       |
|  |  | Auth, Cameras,    |  | Multiplexed:      |  | Escalation checks  |  |       |
|  |  | Zones, Events,    |  |  - Live frames    |  | Threat feed poll   |  |       |
|  |  | Alerts, Cases,    |  |  - Alerts         |  | Baseline learning  |  |       |
|  |  | Forensics, Agents |  |  - Agent activity |  | Embedding cleanup  |  |       |
|  |  | Search, Analytics |  |  - Metrics        |  | Video retention    |  |       |
|  |  | Threat, PACS, LPR |  |  - Notifications  |  | Report generation  |  |       |
|  |  +-------------------+  +-------------------+  +--------------------+  |       |
|  +------------------------------------------------------------------------+       |
|               |                    |                      |                       |
|               v                    v                      v                       |
|  +-------------------+  +-------------------+  +--------------------+             |
|  | POSTGRESQL 16     |  | QDRANT            |  | REDIS 7            |             |
|  | Users, Cameras,   |  | sentinel_events   |  | Session cache      |             |
|  | Zones, Events,    |  | vehicle_sightings |  | Agent memory       |             |
|  | Alerts, Cases,    |  | entity_appearances|  | Pub/Sub channels   |             |
|  | Incidents, Threat |  | audio_events      |  | Rate limiting      |             |
|  | Signatures, Audit |  | frame_embeddings  |  | Celery broker      |             |
|  | Logs, Recordings  |  | (384-dim vectors) |  |                    |             |
|  +-------------------+  +-------------------+  +--------------------+             |
|                                                                                   |
|               +--------------------------------------------------------+          |
|               |              NEXT.JS 16 FRONTEND                       |          |
|               |                                                        |          |
|               |  +---------------+  +---------------+  +------------+  |          |
|               |  | SOC DASHBOARD |  | FORENSICS     |  | AGENT UI   |  |          |
|               |  | Video Wall    |  | Investigation |  | Fleet Mgmt |  |          |
|               |  | Alert Feed    |  | Case Builder  |  | Chat       |  |          |
|               |  | Metrics Bar   |  | Timeline View |  | Cortex     |  |          |
|               |  | Threat Level  |  | What-If Panel |  | Activity   |  |          |
|               |  +---------------+  +---------------+  +------------+  |          |
|               |                                                        |          |
|               |  +---------------+  +---------------+  +------------+  |          |
|               |  | DETECTION     |  | OPERATIONS    |  | ANALYTICS  |  |          |
|               |  | LPR / ReID    |  | Incidents     |  | Trends     |  |          |
|               |  | Audio Intel   |  | Dispatch      |  | Heatmaps   |  |          |
|               |  | Behavioral AI |  | Patrol Routes |  | Facility   |  |          |
|               |  | Entity Track  |  | SOPs / BOLO   |  | Map (GIS)  |  |          |
|               |  +---------------+  +---------------+  +------------+  |          |
|               |                                                        |          |
|               |  65 pages | 57+ components | 8 hooks | WebSocket      |          |
|               +--------------------------------------------------------+          |
+-----------------------------------------------------------------------------------+
```

### Data Flow

```
Camera Feed --> Video Capture (ring buffer) --> YOLO Detection (per frame)
    |                                               |
    |                                               v
    |                                       Threat Engine (165+ signatures)
    |                                               |
    +--> CLIP Embedding --> Qdrant          Alert Manager (dedup + escalate)
    |                                               |
    +--> Gemini Analysis (rate-limited)      WebSocket --> Frontend
    |                                               |
    +--> Auto Recorder (5-min chunks)        Agent Orchestration (Cortex)
                                                    |
                                             Redis Pub/Sub --> All Agents
```

---

## Technology Stack

### Backend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Web Framework | FastAPI (async) | REST API, WebSocket, middleware |
| Language | Python 3.12 | Async/await throughout |
| ORM | SQLAlchemy 2.0 (asyncpg) | Database models, async queries |
| Database | PostgreSQL 16 | Primary data store |
| Vector Database | Qdrant | Semantic search, frame similarity |
| Cache / Pub-Sub | Redis 7 | Sessions, agent comms, rate limiting |
| Task Queue | Celery | Background jobs, scheduled tasks |
| Object Detection | YOLOv8n + ByteTrack | Real-time detection and tracking |
| Visual Embeddings | CLIP ViT-B-32 | Frame similarity, semantic video search |
| Text Embeddings | all-MiniLM-L6-v2 | Event embedding for search (384-dim) |
| LLM (Primary) | Google Gemini (Flash/Pro) | Scene analysis, forensics, chat |
| LLM (Fallback) | Ollama (gemma3:4b) | Local inference when Gemini unavailable |
| Computer Vision | OpenCV | Frame capture, image processing |
| Migrations | Alembic | Schema versioning |
| Auth | JWT (HS256) + bcrypt | Token auth with role-based access |
| Observability | Prometheus, OpenTelemetry | Metrics, distributed tracing |
| Logging | structlog | Structured JSON logging |

### Frontend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Framework | Next.js 16.1.6 (Turbopack) | App Router, SSR |
| Language | TypeScript + React 19 | Type-safe components |
| Styling | Tailwind CSS v4 | Utility-first dark theme |
| UI Components | Radix UI (10 packages) | Accessible dialog, tabs, toast, etc. |
| Icons | Lucide React | 560+ security-relevant icons |
| Charts | Recharts | Bar, area, radial charts |
| Maps | Leaflet + react-leaflet | Facility maps, geofences, tracking |
| State | React hooks + WebSocket | Real-time reactive updates |

### Infrastructure

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Containers | Docker Compose | PostgreSQL, Qdrant, Redis |
| Reverse Proxy | Nginx | Production routing |
| GPU Support | CUDA (optional) | FP16 inference on RTX cards |

---

## Project Structure

```
sentinel-ai/
|
+-- backend/
|   +-- main.py                    # App entrypoint, lifespan, 80+ router mounts
|   +-- config.py                  # Pydantic settings (DB, AI, video, auth)
|   +-- database.py                # Async SQLAlchemy engine + session factory
|   +-- models/
|   |   +-- models.py              # Core: User, Camera, Zone, Event, Alert, Case, etc.
|   |   +-- phase2b_models.py      # Incident, Visitor, VideoWall, SIEM, VIP, Lockdown
|   |   +-- phase3_models.py       # Baselines, ContextRule, Intent, AlarmCorrelation
|   |   +-- agent_state.py         # AgentState, AgentMemory persistence
|   |   +-- agent_audit.py         # AgentAuditLog for all agent actions
|   +-- schemas/                   # Pydantic request/response models
|   +-- api/                       # 80+ REST endpoint modules
|   |   +-- auth.py                # Login, register, token refresh, RBAC
|   |   +-- cameras.py             # Camera CRUD, health, ONVIF
|   |   +-- zones.py               # Zone polygons, occupancy, breach alerts
|   |   +-- events.py              # Event recording, search, filtering
|   |   +-- alerts.py              # Alert lifecycle, escalation, assignment
|   |   +-- cases.py               # Case management, evidence chain
|   |   +-- forensics.py           # Deep analysis, timeline, correlation
|   |   +-- agents.py              # Agent fleet status, lifecycle, audit
|   |   +-- copilot.py             # Natural language SOC assistant
|   |   +-- ws.py                  # WebSocket multiplexing
|   |   +-- lpr.py                 # License plate recognition
|   |   +-- audio.py               # Audio event detection
|   |   +-- weapon_detection.py    # Weapon/tool detection
|   |   +-- pacs.py                # Physical access control
|   |   +-- incidents.py           # Incident lifecycle + SLA
|   |   +-- privacy.py             # PII masking, GDPR/CCPA
|   |   +-- ... (60+ more)
|   +-- services/                  # 80+ service modules
|   |   +-- video_capture.py       # Threaded multi-camera capture
|   |   +-- yolo_detector.py       # YOLOv8 + ByteTrack detection
|   |   +-- gemini_provider.py     # Gemini API client (rate-limited)
|   |   +-- gemini_analyzer.py     # Real-time scene analysis
|   |   +-- gemini_forensics.py    # Deep forensic frame analysis
|   |   +-- clip_pipeline.py       # Background CLIP embedding pipeline
|   |   +-- clip_embedder.py       # CLIP model (ViT-B-32, 512-dim)
|   |   +-- vector_store.py        # Qdrant client (5 collections)
|   |   +-- threat_engine.py       # 165+ hybrid threat signatures
|   |   +-- alert_manager.py       # Dedup, escalation, correlation
|   |   +-- baseline_learning.py   # Per-zone normality baselines
|   |   +-- causal_reasoning.py    # Incident chain analysis
|   |   +-- counterfactual.py      # What-if scenario engine
|   |   +-- intent_classifier.py   # Behavioral intent analysis
|   |   +-- autonomous_response.py # Auto threat response
|   |   +-- ... (60+ more)
|   +-- agents/                    # 16+ autonomous AI agents
|   |   +-- base_agent.py          # Base with memory, tools, circuit breaker
|   |   +-- sentinel_cortex.py     # Supervisor / orchestrator
|   |   +-- sentinel_eye.py        # Continuous camera monitoring
|   |   +-- threat_analyst.py      # Threat scoring and classification
|   |   +-- investigator.py        # Multi-step case investigation
|   |   +-- correlator.py          # Cross-camera event correlation
|   |   +-- lpr_agent.py           # License plate recognition
|   |   +-- audio_agent.py         # Audio event detection
|   |   +-- crowd_monitor.py       # Crowd density and flow
|   |   +-- patrol_agent.py        # Guard patrol optimization
|   |   +-- ghost_tracer.py        # Predictive entity tracking
|   |   +-- ... (5+ more)
|   +-- middleware/
|   |   +-- rate_limit.py          # Token bucket (100 req/min default)
|   |   +-- prometheus_metrics.py  # Prometheus export
|   |   +-- circuit_breaker.py     # External API circuit breaker
|   |   +-- csrf_protection.py     # CSRF token validation
|   |   +-- security_headers.py    # HSTS, CSP, X-Frame-Options
|   |   +-- tracing.py            # OpenTelemetry distributed tracing
|   +-- tasks/                     # Celery periodic tasks
|   +-- templates/                 # Email/report templates
|   +-- reports/                   # Generated report output
|
+-- frontend/
|   +-- src/
|   |   +-- app/                   # 65 page routes (Next.js App Router)
|   |   |   +-- layout.tsx         # Root layout, sidebar, auth, copilot
|   |   |   +-- login/             # Authentication page
|   |   |   +-- command-center/    # SOC command center
|   |   |   +-- video-wall/        # Multi-camera video wall
|   |   |   +-- alerts/            # Alert management
|   |   |   +-- incidents/         # Incident lifecycle
|   |   |   +-- forensics/         # Forensic analysis
|   |   |   +-- cases/             # Case management
|   |   |   +-- search/            # Semantic + forensic search
|   |   |   +-- agents/            # Agent fleet management
|   |   |   +-- copilot/           # SOC Copilot chat
|   |   |   +-- lpr/               # License plate reader
|   |   |   +-- audio/             # Audio intelligence
|   |   |   +-- behavioral/        # Behavioral AI
|   |   |   +-- entity-tracking/   # Entity lifecycle
|   |   |   +-- reid/              # Person re-identification
|   |   |   +-- threat-config/     # Threat signature config
|   |   |   +-- pacs/              # Access control
|   |   |   +-- patrol/            # Patrol command
|   |   |   +-- analytics/         # Dashboards and trends
|   |   |   +-- zones/             # Zone management
|   |   |   +-- site-map/          # GIS facility map
|   |   |   +-- floor-plans/       # Floor plan engine
|   |   |   +-- compliance/        # Compliance dashboard
|   |   |   +-- privacy/           # Privacy and GDPR
|   |   |   +-- settings/          # System settings
|   |   |   +-- admin/             # Multi-tenant administration
|   |   |   +-- ... (40+ more)
|   |   +-- components/
|   |   |   +-- soc/               # SOC dashboard (9 components)
|   |   |   +-- forensics/         # Investigation tools (12 components)
|   |   |   +-- agents/            # Agent UI (6 components)
|   |   |   +-- common/            # Shared utilities (22 components)
|   |   |   +-- copilot/           # Copilot chat widget
|   |   |   +-- map/               # Leaflet facility map
|   |   |   +-- lpr/               # LPR visualization (4 components)
|   |   |   +-- audio/             # Audio heatmap timeline
|   |   |   +-- threat-intel/      # Threat intel panels (3 components)
|   |   |   +-- ui/                # Base UI (Badge, Card)
|   |   +-- hooks/
|   |   |   +-- useWebSocket.ts    # Multi-channel WebSocket with reconnect
|   |   |   +-- useLiveFeed.ts     # Frame + analysis batching
|   |   |   +-- useAlerts.ts       # Alert CRUD + real-time
|   |   |   +-- useThreatResponse.ts  # Threat response tracking
|   |   |   +-- useSmartPolling.ts # Visibility-aware polling
|   |   |   +-- useApiError.ts     # Error handling wrapper
|   |   |   +-- useDebounce.ts     # Debounced state
|   |   |   +-- useKeyboardShortcuts.ts  # Keyboard bindings
|   |   +-- lib/
|   |       +-- types.ts           # 65+ TypeScript interfaces
|   |       +-- utils.ts           # apiFetch, formatters, API config
|   |       +-- export.ts          # CSV, PDF, JSON export utilities
|   +-- package.json
|   +-- tailwind config (v4, CSS-based)
|
+-- docker-compose.yml             # PostgreSQL 16, Qdrant, Redis
+-- docker-compose.prod.yml        # Production with Nginx
+-- nginx.conf                     # Reverse proxy config
+-- requirements.txt               # Python dependencies
+-- alembic.ini                    # Database migration config
+-- yolov8n.pt                     # YOLO model weights
+-- yolov8n-pose.pt                # Pose estimation model weights
```

---

## Agent System

Sentinel AI runs a hierarchical multi-agent system where 16+ specialized agents operate autonomously, coordinated by a central supervisor.

### Agent Tiers

**Supervisor Tier**

| Agent | Role |
|-------|------|
| Sentinel Cortex | Central intelligence coordinator. Orchestrates all agents, resolves conflicting assessments, manages shift handoffs, produces situation reports. |

**Perception Tier (Always-On)**

| Agent | Role |
|-------|------|
| SentinelEye | Continuous round-robin camera monitoring with YOLO + Gemini scene analysis |
| PatrolAgent | Guard patrol tracking and route optimization |
| AnomalyDetector | Statistical anomaly detection against learned baselines |
| CrowdMonitor | Crowd density estimation, flow analysis, stampede risk |
| LPRAgent | License plate recognition and database lookup |
| AudioAgent | Audio event classification (gunshots, screams, glass) |
| EnvironmentalAgent | Temperature, humidity, air quality monitoring |
| TamperAgent | Camera tampering detection (blur, tilt, obstruction) |
| PPEAgent | Personal protective equipment compliance |
| MicroBehaviorAgent | Micro-expression and gait anomaly analysis |

**Reasoning Tier**

| Agent | Role |
|-------|------|
| ThreatAnalyst | Threat severity scoring and kill-chain classification |
| Investigator | Multi-step autonomous incident investigation |
| Correlator | Cross-camera, cross-modal event correlation |
| ReIDAgent | Person re-identification across cameras |
| GhostTracer | Predictive tracking of disappeared entities |
| CompanionAgent | Companion and group relationship discovery |

**Action Tier**

| Agent | Role |
|-------|------|
| ResponseAction | Autonomous threat response (alerts, lockdowns, access revocation) |
| ReportAgent | Automated report generation and formatting |
| DispatchAgent | Operator dispatch, resource assignment |
| ComplianceAgent | Compliance-aware response gating |

### Agent Infrastructure

Each agent inherits from a base class that provides:

- **Async function-calling loop** with Gemini or Ollama
- **Short-term memory** stored in Redis for fast access
- **Long-term memory** persisted to PostgreSQL
- **Circuit breaker** with exponential backoff for failure recovery
- **Token budgeting** per cycle (50,000 tokens default)
- **Tool registry** with access to 50+ specialized tools
- **Full audit logging** of every decision and action
- **Adaptive idle slowdown** to conserve compute when nothing is happening

### Agent Communication

Agents communicate through Redis Pub/Sub on dedicated channels:

```
sentinel:agents:cortex         # Supervisor directives
sentinel:agents:perceptions    # Perception observations
sentinel:agents:threats        # Threat assessments
sentinel:agents:actions        # Action events
sentinel:agents:investigation  # Investigation steps
sentinel:agents:anomalies      # Anomaly reports
sentinel:agents:correlation    # Event correlations
sentinel:agents:predictions    # Predictive insights
sentinel:agents:heartbeat      # Health monitoring
```

---

## Backend Services

The backend contains 80+ service modules organized by domain.

### Core Processing

| Service | Description |
|---------|------------|
| video_capture.py | Threaded multi-camera capture with 30-frame ring buffers, RTSP fallback, auto-reconnection |
| yolo_detector.py | YOLOv8n inference with ByteTrack tracking, dwell time, trajectory analysis |
| clip_pipeline.py | Background CLIP embedding pipeline (ViT-B-32, 512-dim frame vectors) |
| alert_manager.py | Alert deduplication (30s window), severity-based escalation, cross-alert correlation |
| threat_engine.py | 165+ threat signatures with hybrid YOLO + Gemini detection methods |
| auto_recorder.py | Continuous and event-triggered video recording (5-min chunks, 72h retention) |

### AI and LLM

| Service | Description |
|---------|------------|
| gemini_provider.py | Gemini API client with built-in rate limiting (10 req/min) |
| gemini_analyzer.py | Real-time scene analysis via Gemini Flash |
| gemini_forensics.py | Deep forensic frame analysis via Gemini Pro |
| ollama_provider.py | Local Ollama model provider as Gemini fallback |
| ai_text_service.py | Text generation and summarization |
| causal_reasoning.py | Causal inference for incident chain analysis |
| counterfactual_engine.py | "What-if" scenario simulation |
| intent_classifier.py | Behavioral intent classification (authorized/evasive/forced_entry) |
| explanation_builder.py | Explainable AI reasoning chain generation |

### Vector Search

| Service | Description |
|---------|------------|
| vector_store.py | Qdrant client managing 5 collections: sentinel_events, vehicle_sightings, entity_appearances, audio_events, frame_embeddings |
| clip_embedder.py | CLIP model management for visual similarity search |

### Operational

| Service | Description |
|---------|------------|
| incident_lifecycle_service.py | Incident state machine with SLA timers |
| autonomous_response.py | Automated threat response actions |
| pending_action_service.py | Human-in-the-loop approval queue |
| operation_mode.py | Adaptive operation modes (normal/alert/lockdown) |
| emergency_codes.py | No-auth emergency code execution |
| shift_briefing.py | Shift handoff report generation |
| sop_engine.py | Standard Operating Procedure automation |
| patrol_optimizer.py | Guard route optimization |

### Integration

| Service | Description |
|---------|------------|
| pacs_service.py | Physical Access Control System (card readers, turnstiles) |
| alarm_panel_service.py | Alarm panel integration |
| alarm_correlation_engine.py | Cross-modal alarm fusion (PACS + video + sensors) |
| siem_service.py | SIEM integration (Splunk, ELK) |
| mqtt_service.py | MQTT sensor data ingestion |
| onvif_service.py | ONVIF camera protocol support |
| bms_service.py | Building Management System integration |
| elevator_service.py | Elevator system integration |
| bodycam_service.py | Body camera integration |
| gis_service.py | Geographic Information System mapping |

### Privacy and Compliance

| Service | Description |
|---------|------------|
| privacy_engine_service.py | PII masking, privacy zones, data anonymization |
| compliance_auditor.py | Regulatory audit trail (SOC2, HIPAA, PCI-DSS, GDPR/CCPA) |
| compliance_dashboard_service.py | Compliance metrics and dashboards |

---

## API Surface

The backend exposes 80+ REST API endpoint groups and a multiplexed WebSocket server.

### Endpoint Categories

| Category | Prefix | Endpoints | Description |
|----------|--------|-----------|------------|
| Authentication | /api/auth | 4 | Login, register, token refresh, user management |
| Cameras | /api/cameras | 5 | CRUD, health checks, ONVIF discovery |
| Zones | /api/zones | 5 | Polygon CRUD, occupancy tracking, breach alerts |
| Events | /api/events | 8 | Recording, search, filtering, correlation, export |
| Alerts | /api/alerts | 10 | Lifecycle, escalation, assignment, acknowledge, resolve |
| Cases | /api/cases | 8 | Case CRUD, evidence attachment, AI insights |
| Forensics | /api/forensics | 6 | Deep analysis, timeline, context windows |
| Video | /api/video-* | 12 | Playback, bookmarks, archive, summary, wall layouts |
| Search | /api/search | 3 | Full-text, semantic, visual similarity |
| Agents | /api/agents | 8 | Fleet status, lifecycle, audit, conversation |
| Copilot | /api/copilot | 3 | Natural language SOC assistant |
| LPR | /api/lpr | 4 | Plate detection, database, cross-site correlation |
| Audio | /api/audio | 3 | Audio event detection and classification |
| Threat | /api/threat-* | 12 | Signatures, config, intel feeds, response |
| PACS | /api/pacs | 4 | Access control events, door status |
| Incidents | /api/incidents | 6 | Incident lifecycle with SLA tracking |
| Behavioral | /api/behavioral-* | 4 | Behavioral analytics, baselines, intent |
| Privacy | /api/privacy | 5 | PII masking, privacy zones, GDPR |
| Compliance | /api/compliance | 4 | Audit trails, regulatory dashboards |
| Integration | /api/alarm-panels, iot-sensors, siem, etc. | 18 | External system connectors |
| Emergency | /api/emergency | 3 | No-auth lockdown, evacuation codes |

### WebSocket Channels

The `/ws` endpoint multiplexes the following real-time channels:

| Channel | Data | Rate |
|---------|------|------|
| frame / frames | Live MJPEG frames (base64) | Up to 15 FPS |
| alert / alerts | New and updated alerts | Event-driven |
| metric / metrics | System KPIs | 1/s |
| notifications | User notifications | Event-driven |
| agent_activity | Agent execution logs | Event-driven |
| pending_actions | HITL approval queue | Event-driven |
| analysis | Gemini analysis results | Rate-limited |
| crowd_sentiment | Crowd density/mood data | 1/s |
| companion_discovery | Entity relationship detections | Event-driven |
| ghost_trace | Predictive entity paths | Event-driven |
| threat_response | Active response actions | Event-driven |

---

## Frontend Application

The frontend is a Next.js 16 application with 65 page routes organized into 9 navigation groups.

### Page Groups

**Operations** (7 pages): Dashboard, Command Center, Video Wall, Cameras, System Status, SOC Workspace, SOC Copilot

**Alerts and Response** (8 pages): Emergency Response, Alerts, Incidents, Threat Response, Alarm Analysis, Pending Actions (HITL), Mass Notifications, Evacuation

**Investigation** (7 pages): Search (Forensic/Visual/Semantic), Forensics, Cases, Evidence, Link Analysis, Video Summary, Video Archive

**Detection and AI** (8 pages): Agent Fleet Management, Auto Investigations, Behavioral AI, Context Intelligence, Entity Tracking, Person Re-ID, Plate Reader, Audio Intelligence

**Threat Management** (6 pages): Threat Config, Signatures, Threat Intel Feeds, Insider Threat, Tamper Detection, BOLO and Logbook

**Access and Patrol** (7 pages): Access Control (PACS), Visitors, VIP Protection, Patrol Command, Dispatch, Crowd Protocols, SOP Manager

**Analytics and Maps** (7 pages): Analytics Dashboards, Zones, Site Map (GIS), Floor Plans, Global Overwatch, Environmental Safety, SLA Dashboard

**Compliance and Privacy** (2 pages): Compliance Dashboard, Privacy and GDPR Center

**System** (5 pages): Integrations, Webhooks, Settings, Customer Portal, Administration

### Key Component Libraries

**SOC Components** (9 files, 2,000+ lines): Video wall with configurable grid layouts, live alert feed with status colors, camera grid, crowd sentiment badges, live frame/analysis panel, metrics bar, threat level indicator, zone overlays.

**Forensics Components** (12 files, 130,000+ lines): Agent decision timeline, case builder, detection overlay, incident list, incident replay player, investigation panel, multi-camera replay grid, reconstruction panel, semantic search bar, similar frames panel, timeline view, what-if scenario panel.

**Agent Components** (6 files, 75,000+ lines): Agent activity panel, chat interface with Sentinel Cortex, control panel, conversation history, status grid by tier, Cortex overview dashboard.

**Common Components** (22 files): Annotation canvas, bounding box overlay, confidence slider, connection status, data state (loading/empty/error), error boundary, file upload, metric sparklines, neural glass overlay, pose overlay, skeleton loaders, SLA countdown, system health gauge, timeline view, toast notifications.

### Design System

The frontend uses a dark theme optimized for SOC environments:

- Background: #030712 (near-black)
- Card surfaces: #111827
- Accent color: #06b6d4 (cyan)
- Severity mapping: red (critical), orange (high), yellow (medium), blue (low)
- Custom animations: pulse-alert, threat-pulse, slide-in, fade-in, rec-blink
- Glow effects for severity indicators (.glow-red, .glow-cyan, etc.)

---

## Database Schema

### Core Models

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| User | email, hashed_password, role, is_active | Authentication, RBAC |
| Camera | name, source, location, status, fps, zone_id, config (JSONB) | Camera registry |
| Zone | name, zone_type, polygon, max_occupancy, alert_on_breach | Geographic zones |
| Event | camera_id, zone_id, event_type, severity, confidence, detections (JSONB), gemini_analysis | Detection events |
| Alert | event_id, severity, status, threat_type, assigned_to, correlated_alert_ids | Alert lifecycle |
| Case | title, status, priority, assigned_to, ai_insights | Investigation cases |
| CaseEvidence | case_id, evidence_type, reference_id, file_url | Evidence chain |
| Recording | camera_id, file_path, duration_seconds, event_id | Video recordings |
| VideoBookmark | recording_id, timestamp_offset, label, ai_analysis | Bookmarked moments |
| ThreatSignature | name, category, severity, detection_method, yolo_classes, gemini_prompt | Threat rules |
| AuditLog | user_id, action, resource_type, resource_id, ip_address | Audit trail |
| ActivityNotification | name, rule_nl, severity, zones, schedule | NL alert rules |

### Extended Models

| Model | Purpose |
|-------|---------|
| Incident | Full incident lifecycle with SLA timers (acknowledge/respond/resolve) |
| IncidentStatusLog | Status change audit trail |
| Visitor | Pre-registration, check-in/out, overstay detection |
| NotificationBroadcast | Multi-channel emergency broadcasts (email, SMS, push, PA, signage) |
| VideoWallLayout | Multi-monitor grid configuration |
| BehavioralEvent | Suspicious pattern detection (loitering, casing, tailgating) |
| SIEMConnector | External SIEM integration configuration |
| VIPProfile | VIP tracking with location alerts |
| SecurityProcedure | SOP management with automation triggers |
| LockdownSequence | Emergency lockdown automation |

### Intelligence Models

| Model | Purpose |
|-------|---------|
| ActivityBaseline | Learned per-camera/zone/time-slot normality profiles |
| ContextRule | Zone-type-aware context scoring (restricted/kitchen/lobby/server_room) |
| IntentClassification | Behavioral intent (authorized_access/reconnaissance/evasive/forced_entry) |
| AlertFeedback | User feedback for ML model tuning |
| AlarmCorrelation | Cross-modal alarm fusion (PACS + video + sensors) |
| EntityAppearance | Re-identification descriptors for person tracking |
| WeaponDetection | Weapon/tool detection state management |

### Vector Collections (Qdrant)

| Collection | Dimensions | Content |
|------------|-----------|---------|
| sentinel_events | 384 | Text embeddings of security events |
| vehicle_sightings | 384 | Vehicle description embeddings |
| entity_appearances | 384 | Person appearance embeddings |
| audio_events | 384 | Audio event description embeddings |
| frame_embeddings | 512 | CLIP visual frame embeddings |

---

## Threat Detection Engine

The platform ships with 165+ threat signatures using a hybrid detection approach.

### Detection Methods

**YOLO-based**: Triggers when specific object classes are detected (person in restricted zone, knife, backpack in sterile area).

**Gemini-based**: Triggers when Gemini scene analysis contains specific keywords or matches a structured prompt.

**Hybrid**: Combines YOLO object detection with Gemini contextual analysis for higher confidence.

### Signature Categories

| Category | Examples |
|----------|---------|
| Intrusion and Access | Unauthorized entry, tailgating, perimeter breach, fence climbing |
| Violence and Weapons | Weapon detected, physical altercation, aggressive posture |
| Suspicious Behavior | Loitering, casing, abandoned objects, unusual movement patterns |
| Vehicle Anomalies | Restricted zone entry, wrong-way driving, speeding, abandoned vehicle |
| Safety Hazards | Fire/smoke, person down, medical emergency, fall detection |
| Compliance Violations | PPE missing, smoking in restricted area, hard hat violation |
| Crowd Events | Overcrowding, stampede risk, unauthorized gathering |
| Cyber-Physical | Camera tampering, sensor manipulation, network intrusion indicators |

### Auto-Learning

The threat engine learns from operator feedback. When an operator marks a detection as a false positive or confirms a true positive, the system adjusts detection thresholds and can generate new signatures from confirmed incidents.

---

## Integration Layer

Sentinel AI connects to physical security infrastructure through dedicated service modules.

| System | Protocol | Capabilities |
|--------|----------|-------------|
| PACS (Access Control) | API | Card reader events, door lock/unlock, access logs |
| Alarm Panels | API | Zone arm/disarm, alarm trigger/clear, panel status |
| ONVIF Cameras | ONVIF | Discovery, PTZ control, stream URI negotiation |
| IoT Sensors | MQTT, Modbus | Temperature, humidity, air quality, motion |
| SIEM | Syslog, API | Event forwarding to Splunk, ELK Stack |
| Building Management | BACnet, API | HVAC, lighting, elevator control |
| Intercom Systems | SIP, API | Two-way audio, PA announcements |
| Video Management | RTSP, API | Stream ingestion from third-party VMS |
| Body Cameras | API | Footage ingestion and correlation |
| Emergency Services | Webhook | Automated dispatch notifications |

---

## Quick Start

### Prerequisites

- Python 3.12+
- Node.js 20+
- Docker and Docker Compose
- (Optional) NVIDIA GPU with CUDA for accelerated inference

### 1. Start Infrastructure

```bash
cd sentinel-ai
docker-compose up -d
```

This starts PostgreSQL 16 (port 5432), Qdrant (port 6333), and Redis (port 6379).

### 2. Backend Setup

```bash
# Create and activate virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Copy environment config
cp .env.example .env
# Edit .env and set your GEMINI_API_KEY

# Start the backend
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

On startup, the backend will automatically:
- Run database migrations (Alembic)
- Create all tables
- Initialize Qdrant vector collections
- Sync 165+ threat signatures
- Seed the default admin user
- Load YOLOv8 model weights
- Register and start available cameras
- Launch the multi-agent system
- Start background tasks (CLIP pipeline, auto-recorder, monitoring)

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The frontend will be available at http://localhost:3000.

### 4. Default Login

```
Email:    admin@sentinel.local
Password: changeme123
```

---

## Configuration

All configuration is managed through environment variables. See `.env.example` for the complete list.

### Required

| Variable | Description |
|----------|------------|
| GEMINI_API_KEY | Google Gemini API key for AI analysis |
| DATABASE_URL | PostgreSQL async connection string |
| SECRET_KEY | JWT signing secret (change in production) |

### AI and Detection

| Variable | Default | Description |
|----------|---------|------------|
| GEMINI_RATE_LIMIT | 10 | Gemini requests per minute |
| YOLO_MODEL_PATH | models/yolov8n.pt | YOLO model weights |
| YOLO_CONFIDENCE | 0.45 | Detection confidence threshold |
| CLIP_MODEL | ViT-B-32 | CLIP model variant |
| CLIP_INTERVAL | 3.0 | Seconds between CLIP embeddings |
| LLM_MAX_CONCURRENT | 2 | Max concurrent LLM calls |

### Video

| Variable | Default | Description |
|----------|---------|------------|
| MAX_CAMERAS | 16 | Maximum simultaneous cameras |
| CAMERA_BUFFER_SIZE | 30 | Ring buffer frames per camera |
| DEFAULT_FPS | 15 | Target frames per second |
| RECORDING_CHUNK_SECONDS | 300 | Auto-recording chunk duration |
| RECORDING_RETENTION_HOURS | 72 | Recording retention period |

### Authentication

| Variable | Default | Description |
|----------|---------|------------|
| ACCESS_TOKEN_EXPIRE_MINUTES | 480 | JWT token expiry |
| DEFAULT_ADMIN_EMAIL | admin@sentinel.local | Seed admin email |
| DEFAULT_ADMIN_PASSWORD | changeme123 | Seed admin password |

### Infrastructure

| Variable | Default | Description |
|----------|---------|------------|
| REDIS_URL | redis://localhost:6379/0 | Redis connection |
| QDRANT_HOST | localhost | Qdrant host |
| QDRANT_PORT | 6333 | Qdrant REST port |

---

## RBAC and Authentication

The platform implements role-based access control with four tiers.

| Role | Level | Capabilities |
|------|-------|-------------|
| Admin | 4 | Full access. User management, system settings, agent control, all operations. |
| Analyst | 3 | Investigations, cases, forensics, reports, search, threat configuration. |
| Operator | 2 | Camera and zone management, alert handling, dispatch, patrol. |
| Viewer | 1 | Dashboard viewing, search, read-only access to events and alerts. |

Authentication uses JWT tokens (HS256) with bcrypt password hashing. Tokens expire after 480 minutes by default. All mutation endpoints (POST, PUT, PATCH, DELETE) are logged to the audit trail with user ID, IP address, and timestamp.

Emergency endpoints (/api/emergency) bypass authentication to allow lockdown and evacuation activation without credentials.

---

## Deployment

### Development

```bash
docker-compose up -d                    # Infrastructure
uvicorn backend.main:app --reload       # Backend with hot reload
cd frontend && npm run dev              # Frontend with Turbopack
```

### Production

```bash
docker-compose -f docker-compose.prod.yml up -d
```

The production compose file includes Nginx as a reverse proxy with:

- Frontend static files served directly
- Backend API proxied to uvicorn workers
- WebSocket upgrade handling
- SSL termination (configure certificates in nginx.conf)

### GPU Acceleration

If an NVIDIA GPU is available, the platform automatically detects CUDA and runs YOLO inference with FP16 half-precision. No configuration changes are required. CPU fallback is automatic.

### Health Monitoring

The backend exposes Prometheus metrics at the standard metrics endpoint. Key metrics include:

- HTTP request latency (by endpoint, method, status)
- Active WebSocket connections
- Agent cycle times and error rates
- Camera health scores
- Alert processing latency
- Gemini API response times

OpenTelemetry distributed tracing is available for end-to-end request correlation across services.

---

## Middleware Stack

| Middleware | Purpose |
|-----------|---------|
| Rate Limiting | Token bucket: 100 req/min general, 10 req/min login, 30 req/min AI endpoints |
| Prometheus | HTTP latency histograms, business KPI counters |
| Circuit Breaker | Protects external API calls (Gemini, SIEM, PACS) with exponential backoff |
| CSRF Protection | Token validation on state-changing requests |
| Security Headers | HSTS, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options |
| Distributed Tracing | OpenTelemetry trace propagation |
| Audit Logging | All POST/PUT/PATCH/DELETE requests logged with user context |

---

---

## Author

**Sherin Joseph Roy**
[https://sherinjosephroy.link](https://sherinjosephroy.link)

---

## License

Proprietary. All rights reserved.
