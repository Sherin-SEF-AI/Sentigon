"""YOLOv8 inference with ByteTrack tracking, dwell time, and trajectory."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# Lazy imports for heavy ML libs
_model = None
_model_lock = None
_pose_model = None
_pose_model_lock = None
_device = None  # resolved CUDA/CPU device


def _resolve_device() -> str:
    """Resolve the target device for inference (GPU preferred)."""
    global _device
    if _device is not None:
        return _device

    from backend.config import settings
    cfg = getattr(settings, "YOLO_DEVICE", "auto")

    if cfg != "auto":
        _device = cfg
        logger.info("YOLO device (config): %s", _device)
        return _device

    try:
        import torch
        if torch.cuda.is_available():
            _device = "cuda:0"
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1)
            logger.info("YOLO device: GPU %s (%s GB VRAM)", gpu_name, vram_gb)
        else:
            _device = "cpu"
            logger.info("YOLO device: CPU (CUDA not available)")
    except Exception:
        _device = "cpu"
        logger.info("YOLO device: CPU (torch not available)")

    return _device


def _get_model():
    """Lazy-load YOLOv8 model on first use, placed on GPU if available."""
    global _model, _model_lock
    import threading
    if _model_lock is None:
        _model_lock = threading.Lock()
    with _model_lock:
        if _model is None:
            try:
                t0 = time.time()
                from ultralytics import YOLO
                device = _resolve_device()
                _model = YOLO("yolov8n.pt")
                _model.to(device)
                use_half = device.startswith("cuda")
                if use_half:
                    from backend.config import settings
                    use_half = getattr(settings, "GPU_HALF_PRECISION", True)
                elapsed_ms = (time.time() - t0) * 1000
                logger.info("YOLOv8n loaded on %s (FP16=%s) in %.0fms", device, use_half, elapsed_ms)
            except Exception as e:
                logger.error("Failed to load YOLO model: %s", e)
                raise
    return _model


def preload() -> None:
    """Eagerly load all YOLO models at application startup.

    Call this from main.py lifespan to avoid cold-start latency on the
    first inference request.
    """
    t0 = time.time()
    logger.info("YOLO preload: loading detection model...")
    try:
        _get_model()
    except Exception as e:
        logger.error("YOLO preload: detection model failed: %s", e)

    logger.info("YOLO preload: loading pose model...")
    try:
        _get_pose_model()
    except Exception as e:
        logger.warning("YOLO preload: pose model failed (non-critical): %s", e)

    total_ms = (time.time() - t0) * 1000
    logger.info("YOLO preload complete in %.0fms", total_ms)


def _get_pose_model():
    """Lazy-load YOLOv8-pose model on first use, placed on GPU if available."""
    global _pose_model, _pose_model_lock
    import threading
    if _pose_model_lock is None:
        _pose_model_lock = threading.Lock()
    with _pose_model_lock:
        if _pose_model is None:
            try:
                t0 = time.time()
                from ultralytics import YOLO
                device = _resolve_device()
                _pose_model = YOLO("yolov8n-pose.pt")
                _pose_model.to(device)
                elapsed_ms = (time.time() - t0) * 1000
                logger.info("YOLOv8n-pose loaded on %s in %.0fms", device, elapsed_ms)
            except Exception as e:
                logger.error("Failed to load YOLO-pose model: %s", e)
                raise
    return _pose_model


@dataclass
class TrackedObject:
    track_id: int
    class_name: str
    confidence: float
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    center: Tuple[int, int]
    first_seen: float
    last_seen: float
    trajectory: List[Tuple[int, int]] = field(default_factory=list)
    pose_features: Dict[str, Any] = field(default_factory=dict)

    @property
    def dwell_time(self) -> float:
        return self.last_seen - self.first_seen

    @property
    def is_stationary(self) -> bool:
        if len(self.trajectory) < 5:
            return False
        recent = self.trajectory[-5:]
        xs = [p[0] for p in recent]
        ys = [p[1] for p in recent]
        return (max(xs) - min(xs)) < 20 and (max(ys) - min(ys)) < 20


class PoseAnalyzer:
    """Analyzes COCO 17-point pose keypoints for micro-behavior threat indicators.

    Detects: blading stance, target fixation, pre-assault posturing,
    staking behavior, concealed carry, and evasive movement.
    """

    # COCO keypoint indices
    NOSE = 0
    LEFT_EYE = 1
    RIGHT_EYE = 2
    LEFT_EAR = 3
    RIGHT_EAR = 4
    LEFT_SHOULDER = 5
    RIGHT_SHOULDER = 6
    LEFT_ELBOW = 7
    RIGHT_ELBOW = 8
    LEFT_WRIST = 9
    RIGHT_WRIST = 10
    LEFT_HIP = 11
    RIGHT_HIP = 12
    LEFT_KNEE = 13
    RIGHT_KNEE = 14
    LEFT_ANKLE = 15
    RIGHT_ANKLE = 16

    KP_CONF_THRESHOLD = 0.3

    def __init__(self):
        self._kp_history: Dict[int, List[np.ndarray]] = defaultdict(list)
        self._max_history = 30

    def _kp_valid(self, keypoints: np.ndarray, idx: int) -> bool:
        return keypoints[idx, 2] >= self.KP_CONF_THRESHOLD

    def _kp_xy(self, keypoints: np.ndarray, idx: int) -> Optional[Tuple[float, float]]:
        if self._kp_valid(keypoints, idx):
            return (float(keypoints[idx, 0]), float(keypoints[idx, 1]))
        return None

    def update_history(self, track_id: int, keypoints: np.ndarray):
        self._kp_history[track_id].append(keypoints.copy())
        if len(self._kp_history[track_id]) > self._max_history:
            self._kp_history[track_id] = self._kp_history[track_id][-self._max_history:]

    def get_history(self, track_id: int) -> List[np.ndarray]:
        return self._kp_history.get(track_id, [])

    def clean_stale(self, active_track_ids: set):
        stale = [tid for tid in self._kp_history if tid not in active_track_ids]
        for tid in stale:
            del self._kp_history[tid]

    def analyze(
        self,
        track_id: int,
        keypoints: np.ndarray,
        bbox: Tuple[int, int, int, int],
        is_stationary: bool = False,
        dwell_time: float = 0.0,
    ) -> Dict[str, Any]:
        """Run all micro-behavior checks on a single person's pose."""
        self.update_history(track_id, keypoints)
        history = self.get_history(track_id)

        features: Dict[str, Any] = {}

        blading = self.detect_blading(keypoints, bbox)
        if blading:
            features["blading"] = blading

        if len(history) >= 10:
            fixation = self.detect_target_fixation(history)
            if fixation:
                features["target_fixation"] = fixation

        pre_assault = self.detect_pre_assault(keypoints, bbox)
        if pre_assault:
            features["pre_assault"] = pre_assault

        staking = self.detect_staking(keypoints, bbox, is_stationary, dwell_time)
        if staking:
            features["staking"] = staking

        if len(history) >= 15:
            concealed = self.detect_concealed_carry(history)
            if concealed:
                features["concealed_carry"] = concealed

        if len(history) >= 10:
            evasive = self.detect_evasive(history, keypoints)
            if evasive:
                features["evasive"] = evasive

        return features

    def detect_blading(
        self, keypoints: np.ndarray, bbox: Tuple[int, int, int, int],
    ) -> Optional[Dict[str, Any]]:
        """Blading stance: torso turned sideways, shoulders compressed in x relative to bbox.

        Normal frontal view: shoulders span ~40-60% of bbox width.
        Blading: shoulders compressed to < 20% of bbox width.
        """
        ls = self._kp_xy(keypoints, self.LEFT_SHOULDER)
        rs = self._kp_xy(keypoints, self.RIGHT_SHOULDER)
        if not ls or not rs:
            return None

        bbox_w = max(bbox[2] - bbox[0], 1)
        shoulder_dx = abs(ls[0] - rs[0])
        shoulder_ratio = shoulder_dx / bbox_w

        if shoulder_ratio < 0.20:
            estimated_angle = 90 * (1 - shoulder_ratio / 0.5)
            return {
                "detected": True,
                "shoulder_ratio": round(shoulder_ratio, 3),
                "estimated_angle": round(min(estimated_angle, 90), 1),
                "confidence": round(min(0.5 + (0.20 - shoulder_ratio) * 5, 0.95), 3),
            }
        return None

    def detect_target_fixation(self, history: List[np.ndarray]) -> Optional[Dict[str, Any]]:
        """Fixed gaze: head direction vector variance is extremely low over recent frames."""
        head_vectors = []
        for kps in history[-15:]:
            nose = self._kp_xy(kps, self.NOSE)
            ls = self._kp_xy(kps, self.LEFT_SHOULDER)
            rs = self._kp_xy(kps, self.RIGHT_SHOULDER)
            if not nose or not ls or not rs:
                continue
            mid_sx = (ls[0] + rs[0]) / 2
            mid_sy = (ls[1] + rs[1]) / 2
            dx = nose[0] - mid_sx
            dy = nose[1] - mid_sy
            length = max(np.sqrt(dx ** 2 + dy ** 2), 1.0)
            head_vectors.append((dx / length, dy / length))

        if len(head_vectors) < 8:
            return None

        vx = np.var([v[0] for v in head_vectors])
        vy = np.var([v[1] for v in head_vectors])
        total_var = vx + vy

        if total_var < 0.01:
            confidence = min(0.5 + (0.01 - total_var) * 50, 0.95)
            return {
                "detected": True,
                "direction_variance": round(float(total_var), 5),
                "frames_analyzed": len(head_vectors),
                "confidence": round(confidence, 3),
            }
        return None

    def detect_pre_assault(
        self, keypoints: np.ndarray, bbox: Tuple[int, int, int, int],
    ) -> Optional[Dict[str, Any]]:
        """Pre-assault: wide stance (ankle sep > 1.5x hip width) + lowered CoG + arms raised."""
        lh = self._kp_xy(keypoints, self.LEFT_HIP)
        rh = self._kp_xy(keypoints, self.RIGHT_HIP)
        la = self._kp_xy(keypoints, self.LEFT_ANKLE)
        ra = self._kp_xy(keypoints, self.RIGHT_ANKLE)
        ls = self._kp_xy(keypoints, self.LEFT_SHOULDER)
        rs = self._kp_xy(keypoints, self.RIGHT_SHOULDER)

        if not all([lh, rh, la, ra]):
            return None

        hip_width = abs(lh[0] - rh[0])
        ankle_width = abs(la[0] - ra[0])

        if hip_width < 5:
            return None

        stance_ratio = ankle_width / hip_width

        indicators = 0
        conf_sum = 0.0

        # Wide stance
        if stance_ratio > 1.5:
            indicators += 1
            conf_sum += min((stance_ratio - 1.5) * 0.5, 0.3)

        # Lowered center of gravity
        if ls and rs:
            shoulder_mid_y = (ls[1] + rs[1]) / 2
            hip_mid_y = (lh[1] + rh[1]) / 2
            ankle_mid_y = (la[1] + ra[1]) / 2
            torso_h = hip_mid_y - shoulder_mid_y
            leg_h = ankle_mid_y - hip_mid_y
            if torso_h > 10 and leg_h > 10:
                leg_torso_ratio = leg_h / torso_h
                if leg_torso_ratio < 0.9:
                    indicators += 1
                    conf_sum += 0.3

        # Arms raised (wrists at or above hip level)
        lw = self._kp_xy(keypoints, self.LEFT_WRIST)
        rw = self._kp_xy(keypoints, self.RIGHT_WRIST)
        if lw and rw and lh and rh:
            hip_y = (lh[1] + rh[1]) / 2
            if lw[1] <= hip_y and rw[1] <= hip_y:
                indicators += 1
                conf_sum += 0.2

        if indicators >= 2:
            return {
                "detected": True,
                "stance_ratio": round(stance_ratio, 2),
                "indicators": indicators,
                "confidence": round(min(0.4 + conf_sum, 0.95), 3),
            }
        return None

    def detect_staking(
        self,
        keypoints: np.ndarray,
        bbox: Tuple[int, int, int, int],
        is_stationary: bool,
        dwell_time: float,
    ) -> Optional[Dict[str, Any]]:
        """Staking: stationary person at vantage point with extended observation (dwell > 30s)."""
        if not is_stationary or dwell_time < 30.0:
            return None

        confidence = 0.3
        if dwell_time > 60:
            confidence += 0.15
        if dwell_time > 120:
            confidence += 0.15

        # Upper portion of frame heuristic (potential elevation)
        bbox_top_ratio = bbox[1] / max(bbox[3], 1)
        if bbox_top_ratio < 0.4:
            confidence += 0.1

        if confidence >= 0.45:
            return {
                "detected": True,
                "dwell_time": round(dwell_time, 1),
                "confidence": round(min(confidence, 0.90), 3),
            }
        return None

    def detect_concealed_carry(self, history: List[np.ndarray]) -> Optional[Dict[str, Any]]:
        """Concealed carry: asymmetric arm swing — one arm restricted during walking."""
        recent = history[-20:]

        left_wrist_pos = []
        right_wrist_pos = []

        for kps in recent:
            lw = self._kp_xy(kps, self.LEFT_WRIST)
            rw = self._kp_xy(kps, self.RIGHT_WRIST)
            lh = self._kp_xy(kps, self.LEFT_HIP)
            rh = self._kp_xy(kps, self.RIGHT_HIP)
            if lw and rw and lh and rh:
                left_wrist_pos.append((lw[0] - lh[0], lw[1] - lh[1]))
                right_wrist_pos.append((rw[0] - rh[0], rw[1] - rh[1]))

        if len(left_wrist_pos) < 12:
            return None

        left_motion = float(
            np.var([p[0] for p in left_wrist_pos]) + np.var([p[1] for p in left_wrist_pos])
        )
        right_motion = float(
            np.var([p[0] for p in right_wrist_pos]) + np.var([p[1] for p in right_wrist_pos])
        )

        if left_motion < 1 and right_motion < 1:
            return None
        max_motion = max(left_motion, right_motion)
        if max_motion < 5:
            return None

        asymmetry_ratio = min(left_motion, right_motion) / max_motion

        if asymmetry_ratio < 0.30:
            restricted_side = "left" if left_motion < right_motion else "right"
            return {
                "detected": True,
                "asymmetry_ratio": round(asymmetry_ratio, 3),
                "restricted_arm": restricted_side,
                "confidence": round(min(0.45 + (0.30 - asymmetry_ratio) * 2, 0.90), 3),
            }
        return None

    def detect_evasive(
        self, history: List[np.ndarray], keypoints: np.ndarray,
    ) -> Optional[Dict[str, Any]]:
        """Evasive movement: face turned away from camera + erratic direction changes."""
        recent = history[-15:]

        indicators = 0
        conf_sum = 0.0

        # Face avoidance: nose not visible but ears are, or nose at extreme offset
        face_away_count = 0
        for kps in recent:
            nose = self._kp_xy(kps, self.NOSE)
            l_ear = self._kp_xy(kps, self.LEFT_EAR)
            r_ear = self._kp_xy(kps, self.RIGHT_EAR)

            if not nose and (l_ear or r_ear):
                face_away_count += 1
            elif nose:
                ls = self._kp_xy(kps, self.LEFT_SHOULDER)
                rs = self._kp_xy(kps, self.RIGHT_SHOULDER)
                if ls and rs:
                    mid_x = (ls[0] + rs[0]) / 2
                    shoulder_span = abs(ls[0] - rs[0])
                    if shoulder_span > 5 and abs(nose[0] - mid_x) / shoulder_span > 0.8:
                        face_away_count += 1

        face_away_ratio = face_away_count / max(len(recent), 1)
        if face_away_ratio > 0.5:
            indicators += 1
            conf_sum += face_away_ratio * 0.4

        # Frequent direction changes in trajectory
        nose_positions = []
        for kps in recent:
            nose = self._kp_xy(kps, self.NOSE)
            if nose:
                nose_positions.append(nose)

        if len(nose_positions) >= 8:
            direction_changes = 0
            for i in range(2, len(nose_positions)):
                dx1 = nose_positions[i - 1][0] - nose_positions[i - 2][0]
                dx2 = nose_positions[i][0] - nose_positions[i - 1][0]
                dy1 = nose_positions[i - 1][1] - nose_positions[i - 2][1]
                dy2 = nose_positions[i][1] - nose_positions[i - 1][1]
                if (abs(dx1) > 3 and abs(dx2) > 3 and dx1 * dx2 < 0) or \
                   (abs(dy1) > 3 and abs(dy2) > 3 and dy1 * dy2 < 0):
                    direction_changes += 1

            change_rate = direction_changes / (len(nose_positions) - 2)
            if change_rate > 0.4:
                indicators += 1
                conf_sum += change_rate * 0.3

        if indicators >= 1 and conf_sum >= 0.2:
            return {
                "detected": True,
                "face_away_ratio": round(face_away_ratio, 3),
                "indicators": indicators,
                "confidence": round(min(0.35 + conf_sum, 0.90), 3),
            }
        return None


# Singleton pose analyzer
pose_analyzer = PoseAnalyzer()


class YOLODetector:
    """Runs YOLOv8 inference with object tracking."""

    # COCO class names relevant to security
    SECURITY_CLASSES = {
        "person", "car", "truck", "bus", "motorcycle", "bicycle",
        "backpack", "handbag", "suitcase", "knife", "cell phone",
        "laptop", "umbrella", "dog", "cat", "skateboard",
    }

    def __init__(self, confidence_threshold: float = 0.35, track: bool = True):
        self.confidence_threshold = confidence_threshold
        self.track = track
        self._tracked_objects: Dict[int, TrackedObject] = {}
        self._track_history: Dict[str, Dict[int, TrackedObject]] = defaultdict(dict)
        self._class_counts: Dict[str, int] = defaultdict(int)

    def detect(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
    ) -> Dict[str, Any]:
        """Run detection on a frame, return structured results."""
        model = _get_model()
        now = time.time()

        try:
            device = _resolve_device()
            use_half = device.startswith("cuda")
            if self.track:
                results = model.track(
                    frame,
                    persist=True,
                    conf=self.confidence_threshold,
                    tracker="bytetrack.yaml",
                    verbose=False,
                    device=device,
                    half=use_half,
                )
            else:
                results = model(frame, conf=self.confidence_threshold, verbose=False,
                                device=device, half=use_half)
        except Exception as e:
            logger.error("YOLO inference error: %s", e)
            return {"detections": [], "person_count": 0, "vehicle_count": 0}

        detections = []
        person_count = 0
        vehicle_count = 0
        camera_tracks = self._track_history[camera_id]

        for result in results:
            boxes = result.boxes
            if boxes is None or len(boxes) == 0:
                continue

            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i])
                class_name = model.names[cls_id]
                conf = float(boxes.conf[i])
                x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

                track_id = int(boxes.id[i]) if boxes.id is not None else i

                # Update tracking history
                if track_id in camera_tracks:
                    obj = camera_tracks[track_id]
                    obj.bbox = (x1, y1, x2, y2)
                    obj.center = (cx, cy)
                    obj.confidence = conf
                    obj.last_seen = now
                    obj.trajectory.append((cx, cy))
                    # Keep trajectory bounded
                    if len(obj.trajectory) > 100:
                        obj.trajectory = obj.trajectory[-100:]
                else:
                    obj = TrackedObject(
                        track_id=track_id,
                        class_name=class_name,
                        confidence=conf,
                        bbox=(x1, y1, x2, y2),
                        center=(cx, cy),
                        first_seen=now,
                        last_seen=now,
                        trajectory=[(cx, cy)],
                    )
                    camera_tracks[track_id] = obj

                if class_name == "person":
                    person_count += 1
                elif class_name in ("car", "truck", "bus", "motorcycle"):
                    vehicle_count += 1

                det_entry = {
                    "track_id": track_id,
                    "class": class_name,
                    "confidence": round(conf, 3),
                    "bbox": [x1, y1, x2, y2],
                    "center": [cx, cy],
                    "dwell_time": round(obj.dwell_time, 1),
                    "is_stationary": obj.is_stationary,
                }
                if obj.pose_features:
                    det_entry["pose_features"] = obj.pose_features
                detections.append(det_entry)

        # Clean stale tracks (not seen in 10s)
        stale_ids = [
            tid for tid, obj in camera_tracks.items()
            if now - obj.last_seen > 10.0
        ]
        for tid in stale_ids:
            del camera_tracks[tid]

        return {
            "detections": detections,
            "person_count": person_count,
            "vehicle_count": vehicle_count,
            "total_objects": len(detections),
            "active_tracks": len(camera_tracks),
            "timestamp": now,
        }

    def get_tracked_objects(self, camera_id: str) -> List[TrackedObject]:
        """Return current tracked objects for a camera."""
        return list(self._track_history.get(camera_id, {}).values())

    def get_dwell_alerts(self, camera_id: str, threshold_seconds: float = 60.0) -> List[TrackedObject]:
        """Return objects that have been stationary beyond threshold."""
        return [
            obj for obj in self.get_tracked_objects(camera_id)
            if obj.dwell_time > threshold_seconds and obj.is_stationary
        ]

    def get_person_count(self, camera_id: str) -> int:
        tracks = self._track_history.get(camera_id, {})
        return sum(1 for obj in tracks.values() if obj.class_name == "person")

    def detect_pose(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
    ) -> List[Dict[str, Any]]:
        """Run pose estimation on a frame, return keypoints per person.

        Each result contains:
            track_id, bbox, confidence, keypoints (17x3 array of x,y,conf)
        """
        model = _get_pose_model()
        now = time.time()

        try:
            device = _resolve_device()
            use_half = device.startswith("cuda")
            results = model.track(
                frame,
                persist=True,
                conf=self.confidence_threshold,
                tracker="bytetrack.yaml",
                verbose=False,
                device=device,
                half=use_half,
            )
        except Exception as e:
            logger.error("YOLO-pose inference error: %s", e)
            return []

        persons = []
        for result in results:
            boxes = result.boxes
            kps = result.keypoints
            if boxes is None or kps is None or len(boxes) == 0:
                continue

            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i])
                # Pose model only detects persons (cls 0)
                if cls_id != 0:
                    continue

                conf = float(boxes.conf[i])
                x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]
                track_id = int(boxes.id[i]) if boxes.id is not None else i

                # keypoints.data shape: (num_persons, 17, 3)
                person_kps = kps.data[i].cpu().numpy()  # (17, 3)

                persons.append({
                    "track_id": track_id,
                    "bbox": [x1, y1, x2, y2],
                    "confidence": round(conf, 3),
                    "keypoints": person_kps,
                    "timestamp": now,
                })

        return persons

    def analyze_micro_behavior(
        self,
        pose_results: List[Dict[str, Any]],
        camera_id: str = "default",
    ) -> List[Dict[str, Any]]:
        """Run PoseAnalyzer on pose results, enrich TrackedObjects with pose_features.

        Returns list of detections with pose_features attached (only for persons
        with dwell > 3s who have detected micro-behaviors).
        """
        camera_tracks = self._track_history.get(camera_id, {})
        active_ids = set(camera_tracks.keys())
        pose_analyzer.clean_stale(active_ids)

        enriched = []
        for pr in pose_results:
            track_id = pr.get("track_id")
            keypoints = pr.get("keypoints")
            if track_id is None or keypoints is None:
                continue

            tracked = camera_tracks.get(track_id)
            if not tracked or tracked.class_name != "person":
                continue
            if tracked.dwell_time < 3.0:
                continue

            bbox = tracked.bbox
            features = pose_analyzer.analyze(
                track_id=track_id,
                keypoints=keypoints,
                bbox=bbox,
                is_stationary=tracked.is_stationary,
                dwell_time=tracked.dwell_time,
            )

            if features:
                tracked.pose_features = features
                enriched.append({
                    "track_id": track_id,
                    "bbox": list(bbox),
                    "center": list(tracked.center),
                    "dwell_time": round(tracked.dwell_time, 1),
                    "is_stationary": tracked.is_stationary,
                    "class": "person",
                    "confidence": tracked.confidence,
                    "pose_features": features,
                })

        return enriched

    def draw_detections(self, frame: np.ndarray, detections: List[Dict]) -> np.ndarray:
        """Draw bounding boxes and labels on frame."""
        annotated = frame.copy()
        for det in detections:
            x1, y1, x2, y2 = det["bbox"]
            cls = det["class"]
            conf = det["confidence"]
            tid = det.get("track_id", "")
            dwell = det.get("dwell_time", 0)

            # Color based on class
            if cls == "person":
                color = (0, 255, 0)  # Green
            elif cls in ("car", "truck", "bus"):
                color = (255, 165, 0)  # Orange
            elif cls in ("knife",):
                color = (0, 0, 255)  # Red
            else:
                color = (255, 255, 0)  # Yellow

            import cv2
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            label = f"{cls} #{tid} {conf:.0%}"
            if dwell > 5:
                label += f" ({dwell:.0f}s)"
            cv2.putText(annotated, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

        return annotated


# Singleton
yolo_detector = YOLODetector()
