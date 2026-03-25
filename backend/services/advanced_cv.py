"""Advanced Computer Vision Service — multi-model ensemble pipeline.

Extends the base YOLOv8 detector with higher-accuracy models, instance
segmentation, scene classification, anomaly heatmaps, action recognition,
abandoned object detection, and vehicle attribute extraction.
"""

from __future__ import annotations

import logging
import math
import time
import threading
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from backend.services.yolo_detector import yolo_detector, TrackedObject, _resolve_device

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy model handles — mirrors yolo_detector.py pattern
# ---------------------------------------------------------------------------
_medium_model = None
_medium_model_lock: Optional[threading.Lock] = None

_seg_model = None
_seg_model_lock: Optional[threading.Lock] = None


def _get_medium_model():
    """Lazy-load YOLOv8m (medium) on GPU for ensemble on high-priority cameras."""
    global _medium_model, _medium_model_lock
    if _medium_model_lock is None:
        _medium_model_lock = threading.Lock()
    with _medium_model_lock:
        if _medium_model is None:
            try:
                t0 = time.time()
                from ultralytics import YOLO
                device = _resolve_device()
                _medium_model = YOLO("yolov8m.pt")
                _medium_model.to(device)
                elapsed_ms = (time.time() - t0) * 1000
                logger.info("YOLOv8m loaded on %s in %.0fms", device, elapsed_ms)
            except Exception as e:
                logger.error("Failed to load YOLOv8m model: %s", e)
                raise
    return _medium_model


def _get_seg_model():
    """Lazy-load YOLOv8n-seg on GPU for instance segmentation."""
    global _seg_model, _seg_model_lock
    if _seg_model_lock is None:
        _seg_model_lock = threading.Lock()
    with _seg_model_lock:
        if _seg_model is None:
            try:
                t0 = time.time()
                from ultralytics import YOLO
                device = _resolve_device()
                _seg_model = YOLO("yolov8n-seg.pt")
                _seg_model.to(device)
                elapsed_ms = (time.time() - t0) * 1000
                logger.info("YOLOv8n-seg loaded on %s in %.0fms", device, elapsed_ms)
            except Exception as e:
                logger.error("Failed to load YOLOv8n-seg model: %s", e)
                raise
    return _seg_model


# ---------------------------------------------------------------------------
# HSV color name mapping
# ---------------------------------------------------------------------------
_HSV_COLOR_RANGES: List[Tuple[str, Tuple[int, int], Tuple[int, int], Tuple[int, int]]] = [
    # (name, (h_lo, h_hi), (s_lo, s_hi), (v_lo, v_hi))
    ("red",       (0, 10),    (70, 255),  (50, 255)),
    ("red",       (170, 180), (70, 255),  (50, 255)),
    ("orange",    (10, 25),   (70, 255),  (50, 255)),
    ("yellow",    (25, 35),   (70, 255),  (50, 255)),
    ("green",     (35, 85),   (40, 255),  (40, 255)),
    ("blue",      (85, 130),  (40, 255),  (40, 255)),
    ("purple",    (130, 170), (40, 255),  (40, 255)),
    ("white",     (0, 180),   (0, 40),    (200, 255)),
    ("silver",    (0, 180),   (0, 40),    (130, 200)),
    ("gray",      (0, 180),   (0, 40),    (60, 130)),
    ("black",     (0, 180),   (0, 255),   (0, 60)),
]

# Abandonable object classes (COCO)
_ABANDONABLE_CLASSES = {"backpack", "handbag", "suitcase", "umbrella", "skateboard"}

# Vehicle COCO classes
_VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}


def _classify_hsv_color(hsv_roi: np.ndarray) -> str:
    """Return the dominant color name from an HSV region of interest."""
    if hsv_roi.size == 0:
        return "unknown"

    h_mean = float(np.mean(hsv_roi[:, :, 0]))
    s_mean = float(np.mean(hsv_roi[:, :, 1]))
    v_mean = float(np.mean(hsv_roi[:, :, 2]))

    for name, (h_lo, h_hi), (s_lo, s_hi), (v_lo, v_hi) in _HSV_COLOR_RANGES:
        if h_lo <= h_mean <= h_hi and s_lo <= s_mean <= s_hi and v_lo <= v_mean <= v_hi:
            return name
    return "unknown"


def _nms_merge(
    detections: List[Dict[str, Any]],
    iou_threshold: float = 0.55,
) -> List[Dict[str, Any]]:
    """Merge detections from multiple models via class-aware NMS.

    When two boxes overlap above *iou_threshold* and share the same class,
    keep the higher-confidence one and boost its confidence by a small
    agreement factor.
    """
    if not detections:
        return []

    # Group by class for class-aware NMS
    by_class: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for det in detections:
        by_class[det["class"]].append(det)

    merged: List[Dict[str, Any]] = []

    for cls_name, dets in by_class.items():
        # Sort descending by confidence
        dets.sort(key=lambda d: d["confidence"], reverse=True)
        keep: List[Dict[str, Any]] = []

        while dets:
            best = dets.pop(0)
            suppressed: List[int] = []
            agreement_count = 1

            for idx, other in enumerate(dets):
                iou = _compute_iou(best["bbox"], other["bbox"])
                if iou >= iou_threshold:
                    suppressed.append(idx)
                    agreement_count += 1

            # Boost confidence when multiple models agree (cap at 0.99)
            if agreement_count > 1:
                boost = min(0.05 * (agreement_count - 1), 0.10)
                best["confidence"] = round(min(best["confidence"] + boost, 0.99), 3)
                best.setdefault("model_agreement", 1)
                best["model_agreement"] = agreement_count

            keep.append(best)

            # Remove suppressed in reverse order to preserve indices
            for idx in reversed(suppressed):
                dets.pop(idx)

        merged.extend(keep)

    return merged


def _compute_iou(box_a: List[int], box_b: List[int]) -> float:
    """Compute Intersection-over-Union for two [x1, y1, x2, y2] boxes."""
    xa = max(box_a[0], box_b[0])
    ya = max(box_a[1], box_b[1])
    xb = min(box_a[2], box_b[2])
    yb = min(box_a[3], box_b[3])

    inter = max(0, xb - xa) * max(0, yb - ya)
    if inter == 0:
        return 0.0

    area_a = max((box_a[2] - box_a[0]) * (box_a[3] - box_a[1]), 1)
    area_b = max((box_b[2] - box_b[0]) * (box_b[3] - box_b[1]), 1)
    return inter / (area_a + area_b - inter)


# ---------------------------------------------------------------------------
# AdvancedCVService
# ---------------------------------------------------------------------------

class AdvancedCVService:
    """Multi-model ensemble computer vision pipeline for physical security.

    Wraps the base :pyclass:`YOLODetector` singleton and adds ensemble
    detection, instance segmentation, scene classification, anomaly
    heatmaps, abandoned-object detection, vehicle attribute extraction,
    action recognition, and cross-camera appearance descriptors.
    """

    # Scene cache TTL
    _SCENE_CACHE_TTL = 30.0  # seconds

    # Anomaly heatmap sliding window
    _HEATMAP_WINDOW = 300.0  # 5 minutes

    # Heatmap grid resolution
    _HEATMAP_GRID = (64, 48)  # width cells x height cells

    # Proximity threshold (pixels) for abandoned object check
    _ABANDON_PROXIMITY_PX = 150

    # Appearance descriptor histogram bins
    _HIST_BINS = 16

    def __init__(
        self,
        high_priority_cameras: Optional[set] = None,
        confidence_threshold: float = 0.35,
        iou_threshold: float = 0.55,
    ) -> None:
        self._high_priority: set = high_priority_cameras or set()
        self._conf_threshold = confidence_threshold
        self._iou_threshold = iou_threshold

        # Scene classification cache: camera_id -> (timestamp, result)
        self._scene_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

        # Heatmap accumulator: camera_id -> list of (timestamp, cx, cy)
        self._heatmap_points: Dict[str, List[Tuple[float, int, int]]] = defaultdict(list)

        # Abandoned object tracker: camera_id -> {obj_key -> first_seen_ts}
        self._stationary_objects: Dict[str, Dict[str, float]] = defaultdict(dict)

        # Previous frame centers for direction estimation: camera_id -> {track_id -> (cx, cy)}
        self._prev_centers: Dict[str, Dict[int, Tuple[int, int]]] = defaultdict(dict)

        # Pose velocity history for action recognition: (camera_id, track_id) -> list of keypoints
        self._pose_history: Dict[Tuple[str, int], List[np.ndarray]] = defaultdict(list)
        self._pose_history_max = 20

    # ------------------------------------------------------------------
    # 1. Multi-Model Ensemble
    # ------------------------------------------------------------------

    def detect_ensemble(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
    ) -> Dict[str, Any]:
        """Run multi-model ensemble detection with NMS merge.

        Always runs the fast YOLOv8n detector. For cameras in the
        high-priority set, additionally runs YOLOv8m and merges results.
        """
        # Base detection (always)
        base_result = yolo_detector.detect(frame, camera_id)
        base_dets = base_result.get("detections", [])
        for det in base_dets:
            det["source_model"] = "yolov8n"

        if camera_id not in self._high_priority:
            base_result["ensemble"] = False
            return base_result

        # Medium model for high-priority cameras
        try:
            medium_model = _get_medium_model()
            medium_results = medium_model.track(
                frame,
                persist=True,
                conf=self._conf_threshold,
                tracker="bytetrack.yaml",
                verbose=False,
            )
            medium_dets = self._parse_ultralytics_results(
                medium_results, medium_model, source="yolov8m",
            )
        except Exception as e:
            logger.warning("Ensemble medium model failed, using base only: %s", e)
            base_result["ensemble"] = False
            return base_result

        # Merge via NMS
        all_dets = base_dets + medium_dets
        merged = _nms_merge(all_dets, iou_threshold=self._iou_threshold)

        person_count = sum(1 for d in merged if d["class"] == "person")
        vehicle_count = sum(1 for d in merged if d["class"] in _VEHICLE_CLASSES)

        return {
            "detections": merged,
            "person_count": person_count,
            "vehicle_count": vehicle_count,
            "total_objects": len(merged),
            "ensemble": True,
            "timestamp": time.time(),
        }

    # ------------------------------------------------------------------
    # 2. Instance Segmentation
    # ------------------------------------------------------------------

    def segment_instances(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
    ) -> List[Dict[str, Any]]:
        """Run YOLOv8n-seg for pixel-level instance masks.

        Returns a list of dicts each containing mask, bbox, class, and
        confidence for every detected instance.
        """
        try:
            seg_model = _get_seg_model()
            results = seg_model(
                frame,
                conf=self._conf_threshold,
                verbose=False,
            )
        except Exception as e:
            logger.error("Instance segmentation failed: %s", e)
            return []

        instances: List[Dict[str, Any]] = []
        for result in results:
            boxes = result.boxes
            masks = result.masks
            if boxes is None or masks is None or len(boxes) == 0:
                continue

            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i])
                class_name = seg_model.names[cls_id]
                conf = float(boxes.conf[i])
                x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]

                # masks.data: (N, H, W) binary tensor
                mask_tensor = masks.data[i].cpu().numpy().astype(np.uint8)

                instances.append({
                    "class": class_name,
                    "confidence": round(conf, 3),
                    "bbox": [x1, y1, x2, y2],
                    "mask": mask_tensor,
                })

        return instances

    # ------------------------------------------------------------------
    # 3. Scene Classification
    # ------------------------------------------------------------------

    def classify_scene(self, frame: np.ndarray, camera_id: str = "default") -> Dict[str, Any]:
        """Classify overall scene context using heuristic analysis.

        Returns scene_type, lighting, crowd_level, and weather_estimate.
        Results are cached per camera for ``_SCENE_CACHE_TTL`` seconds.
        """
        now = time.time()
        cached = self._scene_cache.get(camera_id)
        if cached and (now - cached[0]) < self._SCENE_CACHE_TTL:
            return cached[1]

        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mean_brightness = float(np.mean(gray))

        # Lighting: day vs night
        if mean_brightness > 130:
            lighting = "day"
        elif mean_brightness > 60:
            lighting = "dusk_dawn"
        else:
            lighting = "night"

        # Scene type heuristic: edge density suggests outdoor (texture-rich)
        edges = cv2.Canny(gray, 50, 150)
        edge_density = float(np.count_nonzero(edges)) / max(edges.size, 1)
        scene_type = "outdoor" if edge_density > 0.08 else "indoor"

        # Crowd level from person count (uses base detector state)
        person_count = yolo_detector.get_person_count(camera_id)
        if person_count == 0:
            crowd_level = "empty"
        elif person_count <= 3:
            crowd_level = "sparse"
        elif person_count <= 10:
            crowd_level = "moderate"
        else:
            crowd_level = "crowded"

        # Weather estimate (outdoor only) — look at top-third brightness variance
        weather_estimate = "clear"
        if scene_type == "outdoor":
            h = frame.shape[0]
            sky_region = gray[: h // 3, :]
            sky_std = float(np.std(sky_region))
            sky_mean = float(np.mean(sky_region))
            if sky_std < 15 and sky_mean < 120:
                weather_estimate = "overcast"
            elif sky_std > 50:
                weather_estimate = "variable"
            else:
                weather_estimate = "clear"

        result: Dict[str, Any] = {
            "scene_type": scene_type,
            "lighting": lighting,
            "crowd_level": crowd_level,
            "person_count": person_count,
            "mean_brightness": round(mean_brightness, 1),
            "edge_density": round(edge_density, 4),
            "weather_estimate": weather_estimate,
        }

        self._scene_cache[camera_id] = (now, result)
        return result

    # ------------------------------------------------------------------
    # 4. Anomaly Heatmap Generation
    # ------------------------------------------------------------------

    def generate_anomaly_heatmap(
        self,
        camera_id: str,
        frame_shape: Tuple[int, int] = (480, 640),
    ) -> Dict[str, Any]:
        """Generate a spatial anomaly heatmap from recent detection positions.

        Accumulates person detection positions over a sliding window and
        returns a normalized 2D array with hot-zone and cold-zone annotations.
        """
        now = time.time()
        cutoff = now - self._HEATMAP_WINDOW

        # Prune old points
        points = self._heatmap_points[camera_id]
        self._heatmap_points[camera_id] = [
            p for p in points if p[0] >= cutoff
        ]
        points = self._heatmap_points[camera_id]

        grid_w, grid_h = self._HEATMAP_GRID
        heatmap = np.zeros((grid_h, grid_w), dtype=np.float32)

        if not points:
            return {
                "heatmap": heatmap,
                "hot_zones": [],
                "cold_zones": [],
                "total_points": 0,
            }

        frame_h, frame_w = frame_shape
        cell_w = max(frame_w / grid_w, 1)
        cell_h = max(frame_h / grid_h, 1)

        for _, cx, cy in points:
            gx = min(int(cx / cell_w), grid_w - 1)
            gy = min(int(cy / cell_h), grid_h - 1)
            heatmap[gy, gx] += 1.0

        # Normalize to [0, 1]
        max_val = float(np.max(heatmap))
        if max_val > 0:
            heatmap /= max_val

        # Identify hot zones (cells above 0.7 threshold)
        hot_zones: List[Dict[str, Any]] = []
        cold_zones: List[Dict[str, Any]] = []

        mean_val = float(np.mean(heatmap[heatmap > 0])) if np.any(heatmap > 0) else 0.0

        for gy in range(grid_h):
            for gx in range(grid_w):
                val = float(heatmap[gy, gx])
                px_x = int((gx + 0.5) * cell_w)
                px_y = int((gy + 0.5) * cell_h)
                if val >= 0.7:
                    hot_zones.append({"grid": [gx, gy], "pixel": [px_x, px_y], "intensity": round(val, 3)})
                elif mean_val > 0.15 and val == 0.0:
                    cold_zones.append({"grid": [gx, gy], "pixel": [px_x, px_y]})

        # Cap cold zones to top-20 for readability
        cold_zones = cold_zones[:20]

        return {
            "heatmap": heatmap,
            "hot_zones": hot_zones,
            "cold_zones": cold_zones,
            "total_points": len(points),
        }

    def accumulate_heatmap_points(
        self,
        camera_id: str,
        detections: List[Dict[str, Any]],
    ) -> None:
        """Feed new person detections into the heatmap accumulator."""
        now = time.time()
        for det in detections:
            if det.get("class") == "person":
                cx, cy = det["center"][0], det["center"][1]
                self._heatmap_points[camera_id].append((now, cx, cy))

    # ------------------------------------------------------------------
    # 5. Abandoned Object Detection
    # ------------------------------------------------------------------

    def detect_abandoned_objects(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
        timeout_seconds: float = 120.0,
    ) -> List[Dict[str, Any]]:
        """Detect objects that appear without a nearby person for too long.

        Tracks backpacks, suitcases, handbags, etc. If an abandonable
        object remains stationary with no person within
        ``_ABANDON_PROXIMITY_PX`` pixels for longer than *timeout_seconds*,
        it is flagged.
        """
        now = time.time()
        result = yolo_detector.detect(frame, camera_id)
        detections = result.get("detections", [])

        person_centers: List[Tuple[int, int]] = []
        abandonable: List[Dict[str, Any]] = []

        for det in detections:
            if det["class"] == "person":
                person_centers.append((det["center"][0], det["center"][1]))
            elif det["class"] in _ABANDONABLE_CLASSES:
                abandonable.append(det)

        cam_objects = self._stationary_objects[camera_id]
        active_keys: set = set()
        alerts: List[Dict[str, Any]] = []

        for obj in abandonable:
            cx, cy = obj["center"][0], obj["center"][1]
            # Stable key: class + quantised position (grid snap to 30px)
            obj_key = f"{obj['class']}_{cx // 30}_{cy // 30}"
            active_keys.add(obj_key)

            # Check proximity to nearest person
            min_dist = float("inf")
            for px, py in person_centers:
                dist = math.hypot(cx - px, cy - py)
                if dist < min_dist:
                    min_dist = dist

            has_nearby_person = min_dist < self._ABANDON_PROXIMITY_PX

            if has_nearby_person:
                # Reset timer — someone is near
                cam_objects.pop(obj_key, None)
                continue

            # No person nearby — start or continue timer
            if obj_key not in cam_objects:
                cam_objects[obj_key] = now

            time_stationary = now - cam_objects[obj_key]
            if time_stationary >= timeout_seconds:
                alerts.append({
                    "class": obj["class"],
                    "bbox": obj["bbox"],
                    "center": obj["center"],
                    "confidence": obj["confidence"],
                    "time_stationary": round(time_stationary, 1),
                    "nearest_person_distance": round(min_dist, 1) if min_dist < float("inf") else None,
                    "abandoned": True,
                })

        # Clean stale keys no longer in frame
        stale = [k for k in cam_objects if k not in active_keys]
        for k in stale:
            del cam_objects[k]

        return alerts

    # ------------------------------------------------------------------
    # 6. Vehicle Attribute Extraction
    # ------------------------------------------------------------------

    def extract_vehicle_attributes(
        self,
        frame: np.ndarray,
        detection: Dict[str, Any],
        camera_id: str = "default",
    ) -> Dict[str, Any]:
        """Extract color, size class, and direction of travel from a vehicle.

        Uses HSV dominant-color analysis for color naming and bounding-box
        area for size classification.
        """
        import cv2

        bbox = detection["bbox"]
        x1, y1, x2, y2 = bbox
        h_frame, w_frame = frame.shape[:2]

        # Clamp to frame bounds
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w_frame, x2)
        y2 = min(h_frame, y2)

        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            return {"color": "unknown", "size_class": "unknown", "direction": "unknown"}

        # Dominant color via HSV
        hsv_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        # Sample centre 60 % to avoid background bleed
        rh, rw = hsv_roi.shape[:2]
        margin_x = int(rw * 0.2)
        margin_y = int(rh * 0.2)
        centre_hsv = hsv_roi[margin_y: rh - margin_y, margin_x: rw - margin_x]
        color = _classify_hsv_color(centre_hsv) if centre_hsv.size > 0 else "unknown"

        # Size class based on bbox area relative to frame
        bbox_area = (x2 - x1) * (y2 - y1)
        frame_area = max(w_frame * h_frame, 1)
        area_ratio = bbox_area / frame_area

        if area_ratio < 0.02:
            size_class = "compact"
        elif area_ratio < 0.06:
            size_class = "sedan"
        elif area_ratio < 0.12:
            size_class = "suv"
        else:
            size_class = "truck"

        # Direction of travel from previous centre
        track_id = detection.get("track_id")
        direction = "unknown"
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

        if track_id is not None:
            prev = self._prev_centers[camera_id].get(track_id)
            if prev is not None:
                dx = cx - prev[0]
                dy = cy - prev[1]
                if abs(dx) > 5 or abs(dy) > 5:
                    angle = math.degrees(math.atan2(-dy, dx)) % 360
                    if 45 <= angle < 135:
                        direction = "up"
                    elif 135 <= angle < 225:
                        direction = "left"
                    elif 225 <= angle < 315:
                        direction = "down"
                    else:
                        direction = "right"
            self._prev_centers[camera_id][track_id] = (cx, cy)

        return {
            "color": color,
            "size_class": size_class,
            "direction": direction,
            "bbox_area_ratio": round(area_ratio, 4),
        }

    # ------------------------------------------------------------------
    # 7. Action Recognition
    # ------------------------------------------------------------------

    def detect_actions(
        self,
        frame: np.ndarray,
        camera_id: str = "default",
    ) -> List[Dict[str, Any]]:
        """Classify per-person actions from pose keypoints and velocity.

        Actions: standing, walking, running, sitting, falling, fighting,
        crouching.
        """
        pose_results = yolo_detector.detect_pose(frame, camera_id)
        if not pose_results:
            return []

        actions: List[Dict[str, Any]] = []

        for pr in pose_results:
            track_id = pr.get("track_id")
            keypoints = pr.get("keypoints")  # (17, 3)
            if track_id is None or keypoints is None:
                continue

            hist_key = (camera_id, track_id)
            history = self._pose_history[hist_key]
            history.append(keypoints.copy())
            if len(history) > self._pose_history_max:
                self._pose_history[hist_key] = history[-self._pose_history_max:]
                history = self._pose_history[hist_key]

            action, confidence = self._classify_action(keypoints, history)
            actions.append({
                "track_id": track_id,
                "action": action,
                "confidence": round(confidence, 3),
            })

        # Prune stale pose histories
        active_keys = {(camera_id, pr["track_id"]) for pr in pose_results if pr.get("track_id") is not None}
        stale = [k for k in self._pose_history if k[0] == camera_id and k not in active_keys]
        for k in stale:
            del self._pose_history[k]

        return actions

    def _classify_action(
        self,
        keypoints: np.ndarray,
        history: List[np.ndarray],
    ) -> Tuple[str, float]:
        """Heuristic action classification from pose geometry and motion.

        Returns (action_name, confidence).
        """
        KP_CONF = 0.3

        def _kp(idx: int) -> Optional[Tuple[float, float]]:
            if keypoints[idx, 2] >= KP_CONF:
                return (float(keypoints[idx, 0]), float(keypoints[idx, 1]))
            return None

        ls = _kp(5)   # left shoulder
        rs = _kp(6)   # right shoulder
        lh = _kp(11)  # left hip
        rh = _kp(12)  # right hip
        lk = _kp(13)  # left knee
        rk = _kp(14)  # right knee
        la = _kp(15)  # left ankle
        ra = _kp(16)  # right ankle
        lw = _kp(9)   # left wrist
        rw = _kp(10)  # right wrist

        # Compute overall velocity from hip midpoint over recent frames
        velocity = 0.0
        if len(history) >= 3 and lh and rh:
            hip_positions: List[Tuple[float, float]] = []
            for kps in history[-5:]:
                if kps[11, 2] >= KP_CONF and kps[12, 2] >= KP_CONF:
                    mx = (float(kps[11, 0]) + float(kps[12, 0])) / 2
                    my = (float(kps[11, 1]) + float(kps[12, 1])) / 2
                    hip_positions.append((mx, my))
            if len(hip_positions) >= 2:
                deltas = [
                    math.hypot(hip_positions[i][0] - hip_positions[i - 1][0],
                               hip_positions[i][1] - hip_positions[i - 1][1])
                    for i in range(1, len(hip_positions))
                ]
                velocity = float(np.mean(deltas))

        # Falling: check if shoulders are below hips (inverted torso)
        if ls and rs and lh and rh:
            shoulder_y = (ls[1] + rs[1]) / 2
            hip_y = (lh[1] + rh[1]) / 2
            if shoulder_y > hip_y + 20:
                return ("falling", 0.80)

        # Sitting: knees significantly above ankles and hip angle near 90 deg
        if lh and rh and lk and rk and la and ra:
            hip_mid_y = (lh[1] + rh[1]) / 2
            knee_mid_y = (lk[1] + rk[1]) / 2
            ankle_mid_y = (la[1] + ra[1]) / 2
            torso_len = abs(knee_mid_y - hip_mid_y)
            shin_len = abs(ankle_mid_y - knee_mid_y)
            if torso_len > 5 and shin_len > 5:
                ratio = shin_len / torso_len
                if ratio < 0.6 and velocity < 5:
                    return ("sitting", 0.75)

        # Crouching: hip-to-ankle vertical distance very small relative to shoulder-hip
        if ls and rs and lh and rh and la and ra:
            sh_y = (ls[1] + rs[1]) / 2
            hip_y = (lh[1] + rh[1]) / 2
            ank_y = (la[1] + ra[1]) / 2
            upper = abs(hip_y - sh_y)
            lower = abs(ank_y - hip_y)
            if upper > 10 and lower < upper * 0.5 and velocity < 8:
                return ("crouching", 0.70)

        # Fighting heuristic: both wrists above shoulder level + high velocity
        if lw and rw and ls and rs:
            sh_y = (ls[1] + rs[1]) / 2
            if lw[1] < sh_y and rw[1] < sh_y and velocity > 15:
                return ("fighting", 0.60)

        # Running vs walking vs standing by velocity
        if velocity > 25:
            return ("running", min(0.55 + velocity / 200, 0.90))
        elif velocity > 6:
            return ("walking", min(0.60 + velocity / 100, 0.85))
        else:
            return ("standing", 0.80)

    # ------------------------------------------------------------------
    # 8. Cross-Camera Appearance Descriptor
    # ------------------------------------------------------------------

    def compute_appearance_descriptor(
        self,
        frame: np.ndarray,
        bbox: List[int],
    ) -> np.ndarray:
        """Compute a compact appearance vector for cross-camera re-ID.

        Extracts a concatenation of spatial HSV color histograms from the
        crop divided into a 3-row layout (head, torso, legs).  The
        resulting vector can be compared with cosine similarity.
        """
        import cv2

        x1, y1, x2, y2 = bbox
        h_frame, w_frame = frame.shape[:2]
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w_frame, x2)
        y2 = min(h_frame, y2)

        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return np.zeros(self._HIST_BINS * 3 * 3, dtype=np.float32)

        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        ch, cw = hsv.shape[:2]

        # Split into 3 horizontal strips
        strip_h = max(ch // 3, 1)
        strips = [
            hsv[0: strip_h, :],
            hsv[strip_h: 2 * strip_h, :],
            hsv[2 * strip_h:, :],
        ]

        descriptor_parts: List[np.ndarray] = []
        bins = self._HIST_BINS

        for strip in strips:
            if strip.size == 0:
                descriptor_parts.append(np.zeros(bins * 3, dtype=np.float32))
                continue
            for ch_idx in range(3):  # H, S, V channels
                hist = cv2.calcHist(
                    [strip], [ch_idx], None,
                    [bins],
                    [0, 180] if ch_idx == 0 else [0, 256],
                )
                hist = hist.flatten().astype(np.float32)
                norm = np.linalg.norm(hist)
                if norm > 0:
                    hist /= norm
                descriptor_parts.append(hist)

        descriptor = np.concatenate(descriptor_parts)
        return descriptor

    # ------------------------------------------------------------------
    # High-priority camera management
    # ------------------------------------------------------------------

    def set_high_priority(self, camera_ids: set) -> None:
        """Update the set of high-priority cameras that use the ensemble."""
        self._high_priority = set(camera_ids)
        logger.info("High-priority cameras updated: %s", self._high_priority)

    def add_high_priority(self, camera_id: str) -> None:
        self._high_priority.add(camera_id)

    def remove_high_priority(self, camera_id: str) -> None:
        self._high_priority.discard(camera_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_ultralytics_results(
        results,
        model,
        source: str = "yolov8m",
    ) -> List[Dict[str, Any]]:
        """Convert raw Ultralytics results into our standard detection dicts."""
        detections: List[Dict[str, Any]] = []
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

                detections.append({
                    "track_id": track_id,
                    "class": class_name,
                    "confidence": round(conf, 3),
                    "bbox": [x1, y1, x2, y2],
                    "center": [cx, cy],
                    "source_model": source,
                })
        return detections


# ---------------------------------------------------------------------------
# Singleton & preload
# ---------------------------------------------------------------------------
advanced_cv = AdvancedCVService()


def preload_advanced_models() -> None:
    """Eagerly load ensemble and segmentation models at startup.

    Call from ``main.py`` lifespan after the base YOLO preload.
    """
    t0 = time.time()
    logger.info("AdvancedCV preload: loading medium model...")
    try:
        _get_medium_model()
    except Exception as e:
        logger.warning("AdvancedCV preload: medium model failed (non-critical): %s", e)

    logger.info("AdvancedCV preload: loading segmentation model...")
    try:
        _get_seg_model()
    except Exception as e:
        logger.warning("AdvancedCV preload: seg model failed (non-critical): %s", e)

    total_ms = (time.time() - t0) * 1000
    logger.info("AdvancedCV preload complete in %.0fms", total_ms)
