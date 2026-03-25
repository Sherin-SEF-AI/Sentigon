/* Core TypeScript types for SENTINEL AI frontend */

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "analyst" | "operator" | "viewer";
  is_active: boolean;
  created_at: string;
}

export interface Camera {
  id: string;
  name: string;
  source: string;
  location: string | null;
  status: "online" | "offline" | "error" | "maintenance";
  fps: number;
  resolution: string | null;
  zone_id: string | null;
  config: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
}

export interface Zone {
  id: string;
  name: string;
  description: string | null;
  zone_type: string;
  polygon: number[][] | null;
  max_occupancy: number | null;
  current_occupancy: number;
  alert_on_breach: boolean;
  is_active: boolean;
  created_at: string;
}

export interface SecurityEvent {
  id: string;
  camera_id: string;
  zone_id: string | null;
  event_type: string;
  description: string | null;
  severity: Severity;
  confidence: number;
  detections: Detection | null;
  frame_url: string | null;
  embedding_id: string | null;
  gemini_analysis: GeminiAnalysis | null;
  timestamp: string;
}

export interface Detection {
  detections: DetectionItem[];
  person_count: number;
  vehicle_count: number;
  total_objects: number;
  active_tracks: number;
  timestamp: number;
}

export interface DetectionItem {
  track_id: number;
  class: string;
  confidence: number;
  bbox: [number, number, number, number];
  center: [number, number];
  dwell_time: number;
  is_stationary: boolean;
}

export interface GeminiAnalysis {
  scene_description: string;
  activity_level: string;
  overall_risk: string;
  persons?: { description: string; behavior: string }[];
  vehicles?: { type: string; behavior: string }[];
  anomalies?: string[];
  threat_indicators?: { type: string; confidence: number; description: string }[];
  recommended_actions?: string[];
  analysis_source: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type AlertStatus =
  | "new"
  | "acknowledged"
  | "investigating"
  | "resolved"
  | "dismissed"
  | "escalated";

export interface Alert {
  id: string;
  event_id: string | null;
  title: string;
  description: string | null;
  severity: Severity;
  status: AlertStatus;
  threat_type: string | null;
  source_camera: string | null;
  zone_name: string | null;
  confidence: number;
  assigned_to: string | null;
  resolution_notes: string | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface Case {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "investigating" | "closed" | "archived";
  priority: Severity;
  assigned_to: string | null;
  tags: string[] | null;
  summary: string | null;
  ai_insights: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface CaseEvidence {
  id: string;
  case_id: string;
  evidence_type: string;
  reference_id: string | null;
  title: string;
  content: string | null;
  file_url: string | null;
  added_at: string;
}

export interface InvestigationRun {
  id: string;
  case_id: string;
  agent_type: string;
  status: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: { action: string; result: Record<string, any>; timestamp: string }[] | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findings: Record<string, any> | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface SOCMetrics {
  total_cameras: number;
  active_cameras: number;
  total_alerts: number;
  critical_alerts: number;
  open_cases: number;
  total_detections_today: number;
  avg_response_time: number | null;
  threat_level: "normal" | "elevated" | "high" | "critical";
}

export interface SearchResult {
  event_id: string;
  score: number;
  description: string | null;
  event_type: string | null;
  camera_id: string | null;
  timestamp: string | null;
  metadata: Record<string, unknown> | null;
}

export type OperationMode = "autonomous" | "hitl";

export type PendingActionStatus = "pending" | "approved" | "rejected" | "expired";

export interface PendingAction {
  id: string;
  agent_name: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  context_summary: string;
  severity: Severity;
  status: PendingActionStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  modified_args: Record<string, unknown> | null;
  execution_result: Record<string, unknown> | null;
  executed_at: string | null;
  created_at: string | null;
  expires_at: string | null;
}

export interface OperationModeStatus {
  mode: OperationMode;
  auto_approve_timeout: number;
  pending_count: number;
}

export interface WSMessage {
  channel: "frame" | "frames" | "alert" | "alerts" | "metric" | "metrics" | "notification" | "notifications" | "agent_activity" | "pending_actions" | "analysis" | "crowd_sentiment" | "companion_discovery" | "ghost_trace" | "threat_response";
  data: Record<string, unknown>;
}

// ── Phase 2 Types ────────────────────────────────────────────

export interface FlowVector {
  grid_x: number;
  grid_y: number;
  vx: number;
  vy: number;
  speed: number;
  person_count: number;
  heading: number;
}

export interface CrowdSentiment {
  sentiment: "calm" | "tense" | "agitated" | "hostile" | "panic";
  avg_speed: number;
  max_speed: number;
  density: number;
  panic_detected: boolean;
  panic_score: number;
  hostile_detected: boolean;
  hostile_score: number;
  stampede_risk: number;
  directional_alignment: number;
  flow_vectors: FlowVector[];
}

export interface BOLOEntry {
  id: string;
  bolo_type: "person" | "vehicle";
  description: Record<string, unknown>;
  plate_text: string | null;
  severity: string;
  reason: string | null;
  active: boolean;
  expires_at: string | null;
  image_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PatrolShift {
  id: string;
  guard_id: string | null;
  zone_ids: string[];
  start_time: string | null;
  end_time: string | null;
  route_waypoints: Record<string, unknown>[];
  status: "scheduled" | "active" | "completed" | "cancelled";
  checkpoints_completed: Record<string, unknown>[];
  created_at: string | null;
}

export interface PatrolRoute {
  id: string;
  name: string;
  zone_sequence: string[];
  risk_score: number;
  estimated_duration_minutes: number;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface VIPProfile {
  id: string;
  name: string;
  description: string | null;
  appearance: Record<string, unknown>;
  threat_level: string;
  active: boolean;
  geofence_radius_meters: number;
  image_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface InsiderThreatProfile {
  id: string;
  user_id: string | null;
  risk_score: number;
  baseline_access_pattern: Record<string, unknown>;
  anomaly_count: number;
  behavioral_flags: string[];
  status: "monitoring" | "flagged" | "cleared";
  created_at: string | null;
  updated_at: string | null;
}

export interface PACSEvent {
  id: string;
  user_identifier: string | null;
  door_id: string | null;
  event_type: "granted" | "denied" | "forced" | "held_open" | "tailgating";
  camera_id: string | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface SOPTemplate {
  id: string;
  threat_type: string;
  severity: string;
  name: string;
  workflow_stages: Record<string, unknown>[];
  auto_trigger: boolean;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface SOPInstance {
  id: string;
  template_id: string;
  alert_id: string | null;
  current_stage: number;
  stage_history: Record<string, unknown>[];
  status: "active" | "completed" | "aborted";
  created_at: string | null;
  updated_at: string | null;
}

export interface DispatchResource {
  id: string;
  resource_type: "police" | "fire" | "ems" | "security";
  name: string;
  status: "available" | "dispatched" | "en_route" | "on_scene";
  current_location: Record<string, unknown>;
  eta_minutes: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CompanionLink {
  id: string;
  entity_a_track_id: number;
  entity_b_track_id: number;
  camera_id: string | null;
  proximity_duration_seconds: number;
  behavioral_sync_score: number;
  link_type: "proximity" | "behavioral" | "both";
  created_at: string | null;
}

export interface NeuralCouncilSession {
  id: string;
  query: string;
  participants: string[];
  messages: { persona: string; response?: string; content?: string }[];
  consensus: Record<string, unknown>;
  status: "active" | "completed" | "failed";
  created_at: string | null;
  updated_at: string | null;
}

export interface Site {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  timezone_str: string;
  total_cameras: number;
  status: "active" | "offline" | "maintenance";
  alert_summary: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: string;
  weight: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  weight: number;
  relationship: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/* ── CLIP Visual Search ────────────────────────────────── */

export interface VisualSearchResult {
  score: number;
  camera_id: string;
  timestamp: string;
  anomaly_score: number;
  is_anomaly: boolean;
  point_id: string;
  metadata: Record<string, unknown>;
}

export interface VisualSearchResponse {
  query: string;
  search_type: "text" | "image" | "frame";
  results: VisualSearchResult[];
  total: number;
  model_info: CLIPModelInfo;
}

export interface CLIPModelInfo {
  model_loaded: boolean;
  model_name: string;
  device: string;
  embedding_dim: number;
  total_inferences: number;
  avg_inference_ms: number;
  clip_enabled: boolean;
}

export interface CLIPStats {
  model_loaded: boolean;
  model_name: string;
  device: string;
  embedding_dim: number;
  total_inferences: number;
  avg_inference_ms: number;
  clip_enabled: boolean;
  pipeline_running: boolean;
  frames_embedded: number;
  anomalies_detected: number;
  cameras_tracking: number;
  collection_size: number;
  embed_interval_s: number;
  anomaly_threshold: number;
  retention_hours: number;
}

export interface VisualAnomaly {
  camera_id: string;
  timestamp: string;
  anomaly_score: number;
}

export interface CLIPCamera {
  camera_id: string;
  name: string;
  location: string | null;
  status: string;
  is_embedding: boolean;
  last_embed_time: number | null;
}

/* ── Video Archive ──────────────────────────────────── */

export type RecordingType = "continuous" | "event_triggered" | "manual";
export type BookmarkType = "marker" | "annotation" | "evidence_flag";

export interface ArchiveRecording {
  id: string;
  camera_id: string;
  camera_name: string | null;
  recording_type: RecordingType;
  file_path: string;
  file_size: number | null;
  duration_seconds: number | null;
  start_time: string;
  end_time: string | null;
  event_id: string | null;
  metadata: Record<string, unknown> | null;
  bookmark_count: number;
}

export interface RecordingListResponse {
  recordings: ArchiveRecording[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface VideoBookmark {
  id: string;
  recording_id: string;
  user_id: string;
  timestamp_offset: number;
  label: string;
  notes: string | null;
  bookmark_type: BookmarkType;
  severity: Severity | null;
  frame_snapshot_path: string | null;
  ai_analysis: Record<string, unknown> | null;
  created_at: string;
}

export interface ForensicAnalysisResult {
  recording_id: string;
  timestamp_offset: number;
  camera_id: string;
  timestamp: string;
  forensic_analysis: Record<string, unknown>;
  similar_frames: VisualSearchResult[];
  ai_provider: string;
}

export interface ArchiveStats {
  total_recordings: number;
  total_duration_seconds: number;
  total_size_bytes: number;
  total_bookmarks: number;
  recordings_by_type: Record<string, number>;
  cameras_with_recordings: number;
}

/* ── Autonomous Threat Response ─────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ThreatResponseAction {
  step_number: number;
  total_steps: number;
  action: string;
  status: "pending" | "executing" | "completed" | "failed";
  details: Record<string, any>;
  timestamp: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ThreatResponse {
  response_id: string;
  alert_id: string;
  severity: Severity;
  threat_type: string;
  confidence: number;
  source_camera: string;
  zone_name: string;
  title: string;
  description: string;
  status: "active" | "completed" | "aborted" | "failed";
  actions: ThreatResponseAction[];
  started_at: string;
  completed_at: string | null;
}

export interface EmergencyService {
  name: string;
  type: "police" | "hospital" | "fire_station" | "clinic";
  latitude: number;
  longitude: number;
  distance_km: number;
  address: string;
  phone: string;
}
