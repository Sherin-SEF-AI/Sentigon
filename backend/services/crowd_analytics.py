"""Crowd Flow Analysis & Sentiment Engine.

Computes real-time crowd flow vectors from ByteTrack trajectories,
detects panic/hostile movement patterns, estimates stampede risk,
and classifies overall crowd sentiment.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class FlowVector:
    """Average velocity vector for a spatial grid cell."""
    grid_x: int
    grid_y: int
    vx: float  # pixels/second horizontal
    vy: float  # pixels/second vertical
    speed: float  # magnitude
    person_count: int
    heading: float  # degrees, 0=right, 90=down


@dataclass
class CrowdFlowResult:
    """Result of crowd flow analysis for a single zone/camera."""
    flow_vectors: List[FlowVector]
    avg_speed: float
    max_speed: float
    density: float  # persons per grid cell average
    directional_alignment: float  # 0=random, 1=perfectly aligned
    dispersion_score: float  # 0=converging, 0.5=neutral, 1=dispersing
    convergence_point: Optional[Tuple[float, float]]  # center of convergence if detected
    panic_detected: bool
    panic_score: float
    hostile_detected: bool
    hostile_score: float
    stampede_risk: float  # 0.0 to 1.0
    sentiment: str  # calm, tense, agitated, hostile, panic


class CrowdFlowAnalyzer:
    """Analyzes crowd flow dynamics from ByteTrack trajectory data.

    Uses spatial grid decomposition to compute per-cell average velocity
    vectors, then detects macro-patterns (panic, hostile convergence,
    stampede risk) from the flow field.
    """

    def __init__(self, grid_size: int = 4, min_trajectory_len: int = 3):
        self.grid_size = grid_size  # NxN grid overlay
        self.min_trajectory_len = min_trajectory_len

    def compute_flow_vectors(
        self,
        tracked_persons: List[Dict[str, Any]],
        frame_width: int = 1280,
        frame_height: int = 720,
    ) -> List[FlowVector]:
        """Compute average velocity vectors per grid cell from trajectories.

        Args:
            tracked_persons: List of dicts with 'trajectory' (list of (x,y)),
                'dwell_time', 'center', 'track_id'.
            frame_width: Video frame width for grid calculation.
            frame_height: Video frame height for grid calculation.

        Returns:
            List of FlowVector objects, one per occupied grid cell.
        """
        cell_w = frame_width / self.grid_size
        cell_h = frame_height / self.grid_size

        # Accumulate velocities per grid cell
        cell_velocities: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}

        for person in tracked_persons:
            traj = person.get("trajectory", [])
            dwell = person.get("dwell_time", 0)

            if len(traj) < self.min_trajectory_len:
                continue

            # Compute velocity from recent trajectory points
            recent = traj[-5:]  # last 5 positions
            if len(recent) < 2:
                continue

            # Average velocity over recent trajectory
            # Assume ~0.1s between frames (10 FPS typical for security)
            dt = max(dwell / max(len(traj), 1), 0.05)
            vx = (recent[-1][0] - recent[0][0]) / (len(recent) * dt)
            vy = (recent[-1][1] - recent[0][1]) / (len(recent) * dt)

            # Determine grid cell from current position
            cx, cy = person.get("center", recent[-1])
            gx = min(int(cx / cell_w), self.grid_size - 1)
            gy = min(int(cy / cell_h), self.grid_size - 1)

            key = (gx, gy)
            if key not in cell_velocities:
                cell_velocities[key] = []
            cell_velocities[key].append((vx, vy))

        # Average velocities per cell
        flow_vectors = []
        for (gx, gy), velocities in cell_velocities.items():
            n = len(velocities)
            avg_vx = sum(v[0] for v in velocities) / n
            avg_vy = sum(v[1] for v in velocities) / n
            speed = math.sqrt(avg_vx ** 2 + avg_vy ** 2)
            heading = math.degrees(math.atan2(avg_vy, avg_vx)) % 360

            flow_vectors.append(FlowVector(
                grid_x=gx,
                grid_y=gy,
                vx=round(avg_vx, 2),
                vy=round(avg_vy, 2),
                speed=round(speed, 2),
                person_count=n,
                heading=round(heading, 1),
            ))

        return flow_vectors

    def detect_panic_movement(self, flow_vectors: List[FlowVector]) -> Tuple[bool, float]:
        """Detect panic: radial dispersion from a center point + high speed.

        Panic signature: people moving AWAY from a common center at high speed.
        Returns (is_panic, panic_score).
        """
        if len(flow_vectors) < 2:
            return False, 0.0

        # Compute centroid of all flow origins
        total_count = sum(fv.person_count for fv in flow_vectors)
        if total_count < 3:
            return False, 0.0

        cx = sum(fv.grid_x * fv.person_count for fv in flow_vectors) / total_count
        cy = sum(fv.grid_y * fv.person_count for fv in flow_vectors) / total_count

        # Check if vectors point AWAY from centroid (dispersion)
        dispersion_scores = []
        speeds = []
        for fv in flow_vectors:
            if fv.speed < 1:
                continue
            # Vector from centroid to cell
            dx_cell = fv.grid_x - cx
            dy_cell = fv.grid_y - cy
            dist = math.sqrt(dx_cell ** 2 + dy_cell ** 2)
            if dist < 0.1:
                continue

            # Normalize
            nx, ny = dx_cell / dist, dy_cell / dist
            # Normalize flow vector
            fv_len = max(fv.speed, 0.01)
            fnx, fny = fv.vx / fv_len, fv.vy / fv_len

            # Dot product: 1 = moving away from center, -1 = toward center
            dot = nx * fnx + ny * fny
            dispersion_scores.append(dot * fv.person_count)
            speeds.append(fv.speed)

        if not dispersion_scores:
            return False, 0.0

        avg_dispersion = sum(dispersion_scores) / sum(
            fv.person_count for fv in flow_vectors if fv.speed >= 1
        )
        avg_speed = sum(speeds) / len(speeds) if speeds else 0

        # Panic: high dispersion (>0.5) + high speed (>50 px/s)
        speed_factor = min(avg_speed / 100, 1.0)
        dispersion_factor = max(avg_dispersion, 0)

        panic_score = dispersion_factor * 0.6 + speed_factor * 0.4
        is_panic = panic_score > 0.55 and avg_speed > 30

        return is_panic, round(panic_score, 3)

    def detect_hostile_movement(
        self, flow_vectors: List[FlowVector],
    ) -> Tuple[bool, float, Optional[Tuple[float, float]]]:
        """Detect hostile convergence: people moving TOWARD a common point.

        Returns (is_hostile, hostile_score, convergence_point).
        """
        if len(flow_vectors) < 2:
            return False, 0.0, None

        total_count = sum(fv.person_count for fv in flow_vectors)
        if total_count < 3:
            return False, 0.0, None

        # Find potential convergence point by projecting flow vectors forward
        # and finding intersection cluster
        endpoints = []
        for fv in flow_vectors:
            if fv.speed < 1:
                continue
            # Project position forward in time
            proj_x = fv.grid_x + fv.vx * 0.01  # normalized small step
            proj_y = fv.grid_y + fv.vy * 0.01
            endpoints.append((proj_x, proj_y, fv.person_count))

        if len(endpoints) < 2:
            return False, 0.0, None

        # Cluster convergence: compute mean endpoint
        tw = sum(e[2] for e in endpoints)
        conv_x = sum(e[0] * e[2] for e in endpoints) / tw
        conv_y = sum(e[1] * e[2] for e in endpoints) / tw

        # Check if vectors point TOWARD the convergence point
        convergence_scores = []
        for fv in flow_vectors:
            if fv.speed < 1:
                continue
            dx = conv_x - fv.grid_x
            dy = conv_y - fv.grid_y
            dist = math.sqrt(dx ** 2 + dy ** 2)
            if dist < 0.1:
                continue

            nx, ny = dx / dist, dy / dist
            fv_len = max(fv.speed, 0.01)
            fnx, fny = fv.vx / fv_len, fv.vy / fv_len

            dot = nx * fnx + ny * fny  # 1 = toward convergence
            convergence_scores.append(dot * fv.person_count)

        if not convergence_scores:
            return False, 0.0, None

        moving_count = sum(fv.person_count for fv in flow_vectors if fv.speed >= 1)
        avg_convergence = sum(convergence_scores) / max(moving_count, 1)

        hostile_score = max(avg_convergence, 0)
        is_hostile = hostile_score > 0.5 and total_count >= 5

        convergence_point = (round(conv_x, 2), round(conv_y, 2)) if is_hostile else None

        return is_hostile, round(hostile_score, 3), convergence_point

    def compute_stampede_risk(
        self,
        flow_vectors: List[FlowVector],
        person_count: int,
        area_capacity: int = 0,
    ) -> float:
        """Compute stampede risk (0.0 to 1.0).

        Factors: density, speed, directional alignment, and capacity utilization.
        """
        if not flow_vectors or person_count < 5:
            return 0.0

        speeds = [fv.speed for fv in flow_vectors]
        avg_speed = sum(speeds) / len(speeds) if speeds else 0
        max_speed = max(speeds) if speeds else 0

        # Density factor
        occupied_cells = len(flow_vectors)
        total_cells = self.grid_size ** 2
        density = person_count / max(occupied_cells, 1)
        density_factor = min(density / 10, 1.0)  # normalize: 10 people/cell = max

        # Speed factor
        speed_factor = min(avg_speed / 80, 1.0)

        # Directional alignment: how uniformly people move in same direction
        if len(flow_vectors) >= 2:
            headings_rad = [math.radians(fv.heading) for fv in flow_vectors if fv.speed > 1]
            if headings_rad:
                mean_cos = sum(math.cos(h) for h in headings_rad) / len(headings_rad)
                mean_sin = sum(math.sin(h) for h in headings_rad) / len(headings_rad)
                alignment = math.sqrt(mean_cos ** 2 + mean_sin ** 2)
            else:
                alignment = 0.0
        else:
            alignment = 0.0

        # Capacity factor
        if area_capacity > 0:
            cap_factor = min(person_count / area_capacity, 2.0) / 2.0
        else:
            cap_factor = min(person_count / 50, 1.0)

        risk = (
            density_factor * 0.30
            + speed_factor * 0.30
            + alignment * 0.20
            + cap_factor * 0.20
        )

        return round(min(risk, 1.0), 3)

    def classify_crowd_sentiment(
        self,
        flow_vectors: List[FlowVector],
        person_count: int,
        area_capacity: int = 0,
    ) -> CrowdFlowResult:
        """Full crowd analysis: flow, panic, hostile, stampede, sentiment.

        Sentiment levels:
        - calm: low speed, no convergence/dispersion
        - tense: moderate density or speed
        - agitated: high speed or hostile convergence beginning
        - hostile: strong convergence pattern detected
        - panic: radial dispersion at high speed
        """
        if not flow_vectors:
            return CrowdFlowResult(
                flow_vectors=[],
                avg_speed=0.0,
                max_speed=0.0,
                density=0.0,
                directional_alignment=0.0,
                dispersion_score=0.5,
                convergence_point=None,
                panic_detected=False,
                panic_score=0.0,
                hostile_detected=False,
                hostile_score=0.0,
                stampede_risk=0.0,
                sentiment="calm",
            )

        speeds = [fv.speed for fv in flow_vectors]
        avg_speed = sum(speeds) / len(speeds) if speeds else 0
        max_speed = max(speeds) if speeds else 0

        occupied_cells = len(flow_vectors)
        density = person_count / max(occupied_cells, 1)

        # Directional alignment
        headings_rad = [math.radians(fv.heading) for fv in flow_vectors if fv.speed > 1]
        if headings_rad:
            mean_cos = sum(math.cos(h) for h in headings_rad) / len(headings_rad)
            mean_sin = sum(math.sin(h) for h in headings_rad) / len(headings_rad)
            alignment = math.sqrt(mean_cos ** 2 + mean_sin ** 2)
        else:
            alignment = 0.0

        # Run detectors
        panic_detected, panic_score = self.detect_panic_movement(flow_vectors)
        hostile_detected, hostile_score, convergence_point = self.detect_hostile_movement(
            flow_vectors
        )
        stampede_risk = self.compute_stampede_risk(flow_vectors, person_count, area_capacity)

        # Compute dispersion score (inverse of hostile convergence)
        dispersion_score = 0.5
        if panic_detected:
            dispersion_score = 0.8 + panic_score * 0.2
        elif hostile_detected:
            dispersion_score = 0.2 - hostile_score * 0.2

        # Classify sentiment
        if panic_detected or stampede_risk > 0.7:
            sentiment = "panic"
        elif hostile_detected and hostile_score > 0.6:
            sentiment = "hostile"
        elif hostile_score > 0.3 or avg_speed > 40 or stampede_risk > 0.4:
            sentiment = "agitated"
        elif avg_speed > 20 or density > 5 or stampede_risk > 0.2:
            sentiment = "tense"
        else:
            sentiment = "calm"

        return CrowdFlowResult(
            flow_vectors=flow_vectors,
            avg_speed=round(avg_speed, 2),
            max_speed=round(max_speed, 2),
            density=round(density, 2),
            directional_alignment=round(alignment, 3),
            dispersion_score=round(dispersion_score, 3),
            convergence_point=convergence_point,
            panic_detected=panic_detected,
            panic_score=panic_score,
            hostile_detected=hostile_detected,
            hostile_score=hostile_score,
            stampede_risk=stampede_risk,
            sentiment=sentiment,
        )

    def analyze_from_tracked_objects(
        self,
        tracked_objects: List[Any],
        frame_width: int = 1280,
        frame_height: int = 720,
        area_capacity: int = 0,
    ) -> CrowdFlowResult:
        """Convenience method: analyze directly from TrackedObject list.

        Args:
            tracked_objects: List of TrackedObject instances from YOLODetector.
        """
        persons = []
        for obj in tracked_objects:
            if getattr(obj, "class_name", "") != "person":
                continue
            persons.append({
                "track_id": obj.track_id,
                "trajectory": obj.trajectory,
                "dwell_time": obj.dwell_time,
                "center": obj.center,
            })

        flow_vectors = self.compute_flow_vectors(persons, frame_width, frame_height)
        return self.classify_crowd_sentiment(
            flow_vectors, len(persons), area_capacity
        )


# Singleton
crowd_flow_analyzer = CrowdFlowAnalyzer()
