"""Entity Link / Knowledge Graph — build graphs from recent alerts and events."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/link-analysis", tags=["link-analysis"])


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/graph", response_model=dict)
async def get_knowledge_graph(
    hours: int = Query(48, ge=1, le=168, description="Time window in hours"),
    _user=Depends(get_current_user),
):
    """Build a knowledge graph from recent alerts (last 48h).

    Nodes = entities (cameras, zones, alert types).
    Edges = co-occurrence.
    Returns {nodes: [{id, label, type, weight}], edges: [{source, target, weight, relationship}]}
    """
    try:
        from backend.models.models import Alert
        from backend.models.phase2_models import CompanionLink

        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            nodes: list = []
            edges: list = []
            node_ids: set = set()

            # ── Fetch recent alerts ───────────────────────────────
            alert_result = await session.execute(
                select(Alert)
                .where(Alert.created_at >= cutoff)
                .order_by(desc(Alert.created_at))
                .limit(500)
            )
            alerts = alert_result.scalars().all()

            # Track co-occurrence between cameras and zones
            camera_zone_pairs: dict = {}
            camera_alert_type_pairs: dict = {}
            zone_alert_type_pairs: dict = {}

            for alert in alerts:
                camera_id = str(alert.source_camera) if getattr(alert, "source_camera", None) else None
                zone_name = getattr(alert, "zone_name", None)
                alert_type = getattr(alert, "threat_type", None) or "unknown"
                severity = alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity)

                # Camera node
                if camera_id:
                    cam_node_id = f"camera_{camera_id}"
                    if cam_node_id not in node_ids:
                        nodes.append({
                            "id": cam_node_id,
                            "label": f"Camera {camera_id}",
                            "type": "camera",
                            "weight": 1,
                        })
                        node_ids.add(cam_node_id)
                    else:
                        # Increment weight
                        for n in nodes:
                            if n["id"] == cam_node_id:
                                n["weight"] += 1
                                break

                # Zone node
                if zone_name:
                    zone_node_id = f"zone_{zone_name}"
                    if zone_node_id not in node_ids:
                        nodes.append({
                            "id": zone_node_id,
                            "label": zone_name,
                            "type": "zone",
                            "weight": 1,
                        })
                        node_ids.add(zone_node_id)
                    else:
                        for n in nodes:
                            if n["id"] == zone_node_id:
                                n["weight"] += 1
                                break

                # Alert type node
                alert_type_node_id = f"alert_type_{alert_type}"
                if alert_type_node_id not in node_ids:
                    nodes.append({
                        "id": alert_type_node_id,
                        "label": alert_type,
                        "type": "alert_type",
                        "weight": 1,
                    })
                    node_ids.add(alert_type_node_id)
                else:
                    for n in nodes:
                        if n["id"] == alert_type_node_id:
                            n["weight"] += 1
                            break

                # Co-occurrence edges: camera <-> zone
                if camera_id and zone_name:
                    pair_key = (f"camera_{camera_id}", f"zone_{zone_name}")
                    camera_zone_pairs[pair_key] = camera_zone_pairs.get(pair_key, 0) + 1

                # Co-occurrence edges: camera <-> alert_type
                if camera_id:
                    pair_key = (f"camera_{camera_id}", alert_type_node_id)
                    camera_alert_type_pairs[pair_key] = camera_alert_type_pairs.get(pair_key, 0) + 1

                # Co-occurrence edges: zone <-> alert_type
                if zone_name:
                    pair_key = (f"zone_{zone_name}", alert_type_node_id)
                    zone_alert_type_pairs[pair_key] = zone_alert_type_pairs.get(pair_key, 0) + 1

            # Build edges from co-occurrence maps
            for (source, target), weight in camera_zone_pairs.items():
                edges.append({
                    "source": source,
                    "target": target,
                    "weight": weight,
                    "relationship": "camera_in_zone",
                })

            for (source, target), weight in camera_alert_type_pairs.items():
                edges.append({
                    "source": source,
                    "target": target,
                    "weight": weight,
                    "relationship": "camera_alert_co_occurrence",
                })

            for (source, target), weight in zone_alert_type_pairs.items():
                edges.append({
                    "source": source,
                    "target": target,
                    "weight": weight,
                    "relationship": "zone_alert_co_occurrence",
                })

            # ── Companion link edges ──────────────────────────────
            try:
                link_result = await session.execute(
                    select(CompanionLink)
                    .where(CompanionLink.created_at >= cutoff)
                    .order_by(desc(CompanionLink.behavioral_sync_score))
                    .limit(200)
                )
                companion_links = link_result.scalars().all()

                for cl in companion_links:
                    node_a_id = f"track_{cl.entity_a_track_id}"
                    node_b_id = f"track_{cl.entity_b_track_id}"

                    if node_a_id not in node_ids:
                        nodes.append({
                            "id": node_a_id,
                            "label": f"Track {cl.entity_a_track_id}",
                            "type": "person_track",
                            "weight": 1,
                        })
                        node_ids.add(node_a_id)

                    if node_b_id not in node_ids:
                        nodes.append({
                            "id": node_b_id,
                            "label": f"Track {cl.entity_b_track_id}",
                            "type": "person_track",
                            "weight": 1,
                        })
                        node_ids.add(node_b_id)

                    edges.append({
                        "source": node_a_id,
                        "target": node_b_id,
                        "weight": cl.behavioral_sync_score or 0.0,
                        "relationship": "companion",
                    })
            except Exception as link_err:
                logger.warning("Could not load companion links for graph: %s", link_err)

            return {
                "nodes": nodes,
                "edges": edges,
                "metadata": {
                    "time_window_hours": hours,
                    "node_count": len(nodes),
                    "edge_count": len(edges),
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                },
            }
    except ImportError as ie:
        logger.warning("Import error building knowledge graph: %s", ie)
        return {
            "nodes": [],
            "edges": [],
            "metadata": {
                "error": "Required models not available",
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to generate knowledge graph")
        raise HTTPException(status_code=500, detail=str(exc))
