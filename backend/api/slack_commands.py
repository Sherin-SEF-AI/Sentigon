"""Slack slash-command handler — /sentinel commands to control SENTINEL AI from Slack."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

from backend.config import settings
from backend.database import async_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/slack", tags=["slack"])

# ── Slack signature verification ──────────────────────────────

SLACK_SIGNING_SECRET = getattr(settings, "SLACK_SIGNING_SECRET", None) or ""


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    """Verify request came from Slack using signing secret."""
    if not SLACK_SIGNING_SECRET:
        return True  # Skip verification if no secret configured
    if abs(time.time() - int(timestamp)) > 300:
        return False  # Reject requests older than 5 minutes
    sig_basestring = f"v0:{timestamp}:{body.decode()}"
    my_sig = "v0=" + hmac.new(
        SLACK_SIGNING_SECRET.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(my_sig, signature)


# ── Internal API caller ───────────────────────────────────────

API_BASE = "http://localhost:8000"


async def _api(method: str, path: str, json_body: dict | None = None) -> dict | list | None:
    """Call internal API endpoint."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.request(method, f"{API_BASE}{path}", json=json_body)
        if resp.status_code >= 400:
            return {"error": f"API returned {resp.status_code}"}
        try:
            return resp.json()
        except Exception:
            return {"raw": resp.text[:500]}


# ── Slack response formatters ─────────────────────────────────

def _text(msg: str) -> dict:
    """Simple ephemeral text response."""
    return {"response_type": "ephemeral", "text": msg}


def _channel(msg: str) -> dict:
    """Visible-to-channel response."""
    return {"response_type": "in_channel", "text": msg}


def _blocks(blocks: list[dict], in_channel: bool = False) -> dict:
    """Block Kit response."""
    return {
        "response_type": "in_channel" if in_channel else "ephemeral",
        "blocks": blocks,
    }


def _header(text: str) -> dict:
    return {"type": "header", "text": {"type": "plain_text", "text": text}}


def _section(text: str) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def _divider() -> dict:
    return {"type": "divider"}


def _fields(pairs: list[tuple[str, str]]) -> dict:
    return {
        "type": "section",
        "fields": [{"type": "mrkdwn", "text": f"*{k}*\n{v}"} for k, v in pairs],
    }


SEVERITY_EMOJI = {
    "critical": ":red_circle:",
    "high": ":large_orange_circle:",
    "medium": ":large_yellow_circle:",
    "low": ":large_blue_circle:",
    "info": ":white_circle:",
}

# ── Command registry ──────────────────────────────────────────

HELP_TEXT = """
:shield: *SENTINEL AI — Slack Command Center*

*System*
`/sentinel status` — System health & overview
`/sentinel mode` — Current operation mode
`/sentinel mode autonomous|hitl` — Change operation mode
`/sentinel performance` — Performance mode status
`/sentinel pending` — Pending HITL actions count

*Cameras*
`/sentinel cameras` — List all cameras with status
`/sentinel camera start <id>` — Start a camera
`/sentinel camera stop <id>` — Stop a camera

*Alerts*
`/sentinel alerts` — Recent high/critical alerts (last 10)
`/sentinel alerts all` — Recent alerts all severities (last 10)
`/sentinel alert ack <id>` — Acknowledge an alert
`/sentinel alert resolve <id>` — Resolve an alert
`/sentinel alert escalate <id>` — Escalate an alert
`/sentinel alert dismiss <id>` — Dismiss an alert
`/sentinel alert stats` — Alert statistics

*Agents*
`/sentinel agents` — Agent fleet status summary
`/sentinel agent start <name>` — Start an agent
`/sentinel agent stop <name>` — Stop an agent
`/sentinel agent restart <name>` — Restart an agent
`/sentinel agents start-all` — Start all agents
`/sentinel agents stop-all` — Stop all agents

*Zones*
`/sentinel zones` — List all zones
`/sentinel zone occupancy <id>` — Zone occupancy

*Threat Intel*
`/sentinel threats` — Active threat intelligence
`/sentinel threat-level` — Current threat sensitivity

*License Plates*
`/sentinel plates` — Recent plate detections
`/sentinel plate search <number>` — Search for a plate
`/sentinel watchlist` — Current LPR watchlist

*People*
`/sentinel reid` — Re-ID stats & recent profiles
`/sentinel crowd` — Crowd protocol status

*Operations*
`/sentinel patrol` — Active patrol routes
`/sentinel shifts` — Active shifts
`/sentinel cases` — Open cases
`/sentinel sop` — Active SOP instances

*Analytics*
`/sentinel analytics events` — Events over time
`/sentinel analytics severity` — Alerts by severity
`/sentinel analytics zones` — Zone occupancy overview

*Search*
`/sentinel search <query>` — Semantic search across events

*Webhooks*
`/sentinel webhooks` — List configured webhooks
`/sentinel webhook test <id>` — Test a webhook

*Other*
`/sentinel sites` — Site overview
`/sentinel tamper` — Tamper detection status
`/sentinel environmental` — Environmental hazard status
`/sentinel help` — Show this help
"""


async def cmd_help(_args: str) -> dict:
    return _text(HELP_TEXT)


# ── System commands ───────────────────────────────────────────

async def cmd_status(_args: str) -> dict:
    health = await _api("GET", "/health")
    status = await _api("GET", "/api/status")
    fleet = await _api("GET", "/api/agents/fleet")
    cameras = await _api("GET", "/api/cameras")
    alert_stats = await _api("GET", "/api/alerts/stats")
    pending = await _api("GET", "/api/operation-mode/pending-actions/count")

    cam_list = cameras if isinstance(cameras, list) else []
    online = sum(1 for c in cam_list if c.get("status") == "online")
    total_cams = len(cam_list)

    fleet_data = fleet if isinstance(fleet, dict) else {}
    active_agents = fleet_data.get("active", 0)
    total_agents = fleet_data.get("total", 0)
    degraded = fleet_data.get("degraded", 0)

    stats = alert_stats if isinstance(alert_stats, dict) else {}
    pending_count = pending.get("count", 0) if isinstance(pending, dict) else 0

    blocks = [
        _header(":shield: SENTINEL AI — System Status"),
        _fields([
            (":heartbeat: Health", health.get("status", "unknown") if isinstance(health, dict) else "unknown"),
            (":movie_camera: Cameras", f"{online}/{total_cams} online"),
            (":robot_face: Agents", f"{active_agents}/{total_agents} active" + (f" ({degraded} degraded)" if degraded else "")),
            (":rotating_light: Open Alerts", str(stats.get("total_open", stats.get("total", "—")))),
            (":clipboard: Pending HITL", str(pending_count)),
            (":warning: Critical", str(stats.get("critical", 0))),
        ]),
        _divider(),
        _section(f":clock1: _System uptime and monitoring active_"),
    ]
    return _blocks(blocks, in_channel=True)


async def cmd_mode(args: str) -> dict:
    if args in ("autonomous", "hitl"):
        result = await _api("PUT", "/api/operation-mode", {"mode": args})
        if isinstance(result, dict) and result.get("error"):
            return _text(f":x: Failed to change mode: {result['error']}")
        return _channel(f":white_check_mark: Operation mode changed to *{args.upper()}*")
    mode = await _api("GET", "/api/operation-mode")
    if isinstance(mode, dict):
        current = mode.get("mode", "unknown")
        timeout = mode.get("auto_approve_timeout_seconds", "—")
        return _text(f":gear: *Operation Mode:* `{current}`\n:timer_clock: Auto-approve timeout: {timeout}s")
    return _text(":gear: Could not fetch operation mode")


async def cmd_performance(_args: str) -> dict:
    perf = await _api("GET", "/api/operation-mode/performance")
    if isinstance(perf, dict):
        return _text(f":zap: *Performance Mode:* `{perf.get('mode', 'unknown')}`")
    return _text(":zap: Could not fetch performance mode")


async def cmd_pending(_args: str) -> dict:
    pending = await _api("GET", "/api/operation-mode/pending-actions/count")
    count = pending.get("count", 0) if isinstance(pending, dict) else 0
    if count == 0:
        return _text(":white_check_mark: No pending HITL actions")
    actions = await _api("GET", "/api/operation-mode/pending-actions")
    items = actions if isinstance(actions, list) else []
    lines = [f":clipboard: *{count} Pending HITL Actions*\n"]
    for a in items[:10]:
        lines.append(f"• `{a.get('id', '?')[:8]}` — {a.get('action_type', '?')}: _{a.get('description', 'no description')}_")
    return _text("\n".join(lines))


# ── Camera commands ───────────────────────────────────────────

async def cmd_cameras(_args: str) -> dict:
    cameras = await _api("GET", "/api/cameras")
    cam_list = cameras if isinstance(cameras, list) else []
    if not cam_list:
        return _text(":movie_camera: No cameras configured")

    status_emoji = {"online": ":large_green_circle:", "offline": ":black_circle:", "error": ":red_circle:", "maintenance": ":large_yellow_circle:"}
    lines = [":movie_camera: *Cameras*\n"]
    for c in cam_list:
        emoji = status_emoji.get(c.get("status", ""), ":white_circle:")
        active = ":arrow_forward:" if c.get("is_active") else ":stop_button:"
        lines.append(f"{emoji} {active} *{c.get('name', c.get('id', '?'))}* — `{c.get('id', '?')}` ({c.get('status', '?')})")
    return _text("\n".join(lines))


async def cmd_camera_action(args: str) -> dict:
    parts = args.strip().split(None, 1)
    if len(parts) < 2:
        return _text(":x: Usage: `/sentinel camera start|stop <camera_id>`")
    action, cam_id = parts[0], parts[1]
    if action not in ("start", "stop"):
        return _text(":x: Usage: `/sentinel camera start|stop <camera_id>`")
    result = await _api("POST", f"/api/cameras/{cam_id}/{action}")
    if isinstance(result, dict) and result.get("error"):
        return _text(f":x: Failed to {action} camera `{cam_id}`: {result['error']}")
    emoji = ":arrow_forward:" if action == "start" else ":stop_button:"
    return _channel(f"{emoji} Camera `{cam_id}` — *{action}* command sent")


# ── Alert commands ────────────────────────────────────────────

async def cmd_alerts(args: str) -> dict:
    params = "?limit=10&sort=created_at:desc"
    if args != "all":
        params += "&severity=high,critical"
    alerts = await _api("GET", f"/api/alerts{params}")
    alert_list = alerts.get("alerts", []) if isinstance(alerts, dict) else (alerts if isinstance(alerts, list) else [])
    if not alert_list:
        return _text(":white_check_mark: No alerts found")

    blocks = [_header(":rotating_light: Recent Alerts")]
    for a in alert_list[:10]:
        sev = a.get("severity", "info").lower()
        emoji = SEVERITY_EMOJI.get(sev, ":white_circle:")
        aid = str(a.get("id", "?"))[:8]
        title = a.get("title", "Untitled")
        status = a.get("status", "?")
        ts = a.get("created_at", "?")[:19] if a.get("created_at") else "?"
        blocks.append(_section(f"{emoji} `{aid}` *{title}*\nSeverity: `{sev}` | Status: `{status}` | {ts}"))
    return _blocks(blocks)


async def cmd_alert_action(args: str) -> dict:
    parts = args.strip().split(None, 1)
    if len(parts) < 2:
        return _text(":x: Usage: `/sentinel alert ack|resolve|escalate|dismiss <alert_id>`")
    action, alert_id = parts[0], parts[1]
    action_map = {
        "ack": "acknowledge", "acknowledge": "acknowledge",
        "resolve": "resolve", "escalate": "escalate",
        "dismiss": "dismiss",
    }
    endpoint = action_map.get(action)
    if not endpoint:
        return _text(f":x: Unknown alert action `{action}`. Use: ack, resolve, escalate, dismiss")
    result = await _api("POST", f"/api/alerts/{alert_id}/{endpoint}")
    if isinstance(result, dict) and result.get("error"):
        return _text(f":x: Failed to {endpoint} alert `{alert_id}`: {result['error']}")
    emoji_map = {"acknowledge": ":eyes:", "resolve": ":white_check_mark:", "escalate": ":arrow_up:", "dismiss": ":wastebasket:"}
    return _channel(f"{emoji_map.get(endpoint, ':gear:')} Alert `{alert_id}` — *{endpoint}d*")


async def cmd_alert_stats(_args: str) -> dict:
    stats = await _api("GET", "/api/alerts/stats")
    if not isinstance(stats, dict):
        return _text(":x: Could not fetch alert stats")
    blocks = [
        _header(":bar_chart: Alert Statistics"),
        _fields([
            (":rotating_light: Total Open", str(stats.get("total_open", stats.get("total", "—")))),
            (":red_circle: Critical", str(stats.get("critical", 0))),
            (":large_orange_circle: High", str(stats.get("high", 0))),
            (":large_yellow_circle: Medium", str(stats.get("medium", 0))),
            (":large_blue_circle: Low", str(stats.get("low", 0))),
            (":white_check_mark: Resolved Today", str(stats.get("resolved_today", 0))),
        ]),
    ]
    return _blocks(blocks)


# ── Agent commands ────────────────────────────────────────────

async def cmd_agents(_args: str) -> dict:
    agents = await _api("GET", "/api/agents/status")
    fleet = await _api("GET", "/api/agents/fleet")
    agent_list = agents if isinstance(agents, list) else []
    fleet_data = fleet if isinstance(fleet, dict) else {}

    blocks = [
        _header(":robot_face: Agent Fleet"),
        _fields([
            ("Total", str(fleet_data.get("total", len(agent_list)))),
            ("Active", str(fleet_data.get("active", 0))),
            ("Degraded", str(fleet_data.get("degraded", 0))),
            ("Stopped", str(fleet_data.get("stopped", 0))),
        ]),
        _divider(),
    ]

    status_emoji = {"running": ":large_green_circle:", "active": ":large_green_circle:", "degraded": ":large_yellow_circle:", "stopped": ":black_circle:", "error": ":red_circle:", "circuit_open": ":red_circle:"}
    for a in agent_list[:23]:
        name = a.get("name", "?")
        st = a.get("status_text", a.get("status", "?"))
        emoji = status_emoji.get(st, ":white_circle:")
        tier = a.get("tier", "")
        blocks.append(_section(f"{emoji} *{name}* — `{st}`" + (f" | tier: {tier}" if tier else "")))

    return _blocks(blocks)


async def cmd_agent_action(args: str) -> dict:
    parts = args.strip().split(None, 1)
    if len(parts) < 2:
        return _text(":x: Usage: `/sentinel agent start|stop|restart <agent_name>`")
    action, agent_name = parts[0], parts[1]
    if action not in ("start", "stop", "restart"):
        return _text(":x: Usage: `/sentinel agent start|stop|restart <agent_name>`")
    result = await _api("POST", f"/api/agents/{agent_name}/{action}")
    if isinstance(result, dict) and result.get("error"):
        return _text(f":x: Failed to {action} agent `{agent_name}`: {result['error']}")
    emoji = {"start": ":arrow_forward:", "stop": ":stop_button:", "restart": ":arrows_counterclockwise:"}
    return _channel(f"{emoji.get(action, ':gear:')} Agent `{agent_name}` — *{action}* command sent")


async def cmd_agents_bulk(args: str) -> dict:
    if args == "start-all":
        result = await _api("POST", "/api/agents/start-all")
        return _channel(":arrow_forward: *Start all agents* command sent")
    elif args == "stop-all":
        result = await _api("POST", "/api/agents/stop-all")
        return _channel(":stop_button: *Stop all agents* command sent")
    return _text(":x: Usage: `/sentinel agents start-all|stop-all`")


# ── Zone commands ─────────────────────────────────────────────

async def cmd_zones(_args: str) -> dict:
    zones = await _api("GET", "/api/zones")
    zone_list = zones if isinstance(zones, list) else []
    if not zone_list:
        return _text(":world_map: No zones configured")
    lines = [":world_map: *Zones*\n"]
    for z in zone_list[:20]:
        lines.append(f"• `{z.get('id', '?')[:8]}` *{z.get('name', '?')}* — type: {z.get('zone_type', '?')}")
    return _text("\n".join(lines))


async def cmd_zone_occupancy(args: str) -> dict:
    if not args:
        return _text(":x: Usage: `/sentinel zone occupancy <zone_id>`")
    result = await _api("GET", f"/api/zones/{args.strip()}/occupancy")
    if isinstance(result, dict) and result.get("error"):
        return _text(f":x: {result['error']}")
    if isinstance(result, dict):
        return _text(f":busts_in_silhouette: Zone `{args.strip()}` occupancy: *{result.get('current_count', result.get('count', '?'))}* people")
    return _text(":x: Could not fetch zone occupancy")


# ── Threat intel commands ─────────────────────────────────────

async def cmd_threats(_args: str) -> dict:
    intel = await _api("GET", "/api/threat-intel/active")
    if isinstance(intel, dict):
        level = intel.get("threat_level", intel.get("level", "unknown"))
        indicators = intel.get("indicators", [])
        lines = [f":warning: *Active Threat Intelligence*\nThreat Level: *{level}*\n"]
        for ind in indicators[:10] if isinstance(indicators, list) else []:
            lines.append(f"• {ind.get('type', '?')}: _{ind.get('description', ind.get('value', '?'))}_")
        return _text("\n".join(lines) if lines else ":white_check_mark: No active threats")
    return _text(":white_check_mark: No active threat intelligence")


async def cmd_threat_level(_args: str) -> dict:
    sens = await _api("GET", "/api/threat-config/sensitivity")
    if isinstance(sens, dict):
        return _text(f":thermometer: *Threat Sensitivity:* `{sens.get('level', sens.get('sensitivity', '?'))}`")
    return _text(":x: Could not fetch threat sensitivity")


# ── LPR commands ──────────────────────────────────────────────

async def cmd_plates(_args: str) -> dict:
    plates = await _api("GET", "/api/lpr/plates?limit=10")
    plate_list = plates if isinstance(plates, list) else plates.get("plates", []) if isinstance(plates, dict) else []
    if not plate_list:
        return _text(":car: No recent plate detections")
    lines = [":car: *Recent Plate Detections*\n"]
    for p in plate_list[:10]:
        plate = p.get("plate_number", p.get("plate", "?"))
        ts = str(p.get("timestamp", p.get("detected_at", "?")))[:19]
        cam = p.get("camera_id", "?")
        lines.append(f"• `{plate}` — cam: `{cam}` at {ts}")
    return _text("\n".join(lines))


async def cmd_plate_search(args: str) -> dict:
    if not args:
        return _text(":x: Usage: `/sentinel plate search <plate_number>`")
    result = await _api("GET", f"/api/lpr/search?query={args.strip()}")
    results = result if isinstance(result, list) else result.get("results", []) if isinstance(result, dict) else []
    if not results:
        return _text(f":mag: No results for plate `{args.strip()}`")
    lines = [f":mag: *Plate Search: {args.strip()}*\n"]
    for r in results[:10]:
        plate = r.get("plate_number", r.get("plate", "?"))
        ts = str(r.get("timestamp", r.get("detected_at", "?")))[:19]
        lines.append(f"• `{plate}` at {ts}")
    return _text("\n".join(lines))


async def cmd_watchlist(_args: str) -> dict:
    wl = await _api("GET", "/api/lpr/watchlist")
    items = wl if isinstance(wl, list) else wl.get("entries", []) if isinstance(wl, dict) else []
    if not items:
        return _text(":clipboard: Watchlist is empty")
    lines = [":clipboard: *LPR Watchlist*\n"]
    for w in items[:15]:
        plate = w.get("plate_number", w.get("plate", "?"))
        reason = w.get("reason", "—")
        lines.append(f"• `{plate}` — {reason}")
    return _text("\n".join(lines))


# ── Re-ID commands ────────────────────────────────────────────

async def cmd_reid(_args: str) -> dict:
    stats = await _api("GET", "/api/reid/stats")
    if isinstance(stats, dict):
        return _text(
            f":bust_in_silhouette: *Re-ID Stats*\n"
            f"Profiles: *{stats.get('total_profiles', '?')}*\n"
            f"Active tracks: *{stats.get('active_tracks', '?')}*\n"
            f"Flagged: *{stats.get('flagged', '?')}*"
        )
    return _text(":bust_in_silhouette: Could not fetch Re-ID stats")


async def cmd_crowd(_args: str) -> dict:
    crowd = await _api("GET", "/api/crowd-protocols/status")
    if isinstance(crowd, dict):
        level = crowd.get("level", crowd.get("crowd_level", "?"))
        return _text(f":people_holding_hands: *Crowd Status:* level `{level}`")
    return _text(":people_holding_hands: Could not fetch crowd status")


# ── Operations commands ───────────────────────────────────────

async def cmd_patrol(_args: str) -> dict:
    routes = await _api("GET", "/api/patrol/routes")
    route_list = routes if isinstance(routes, list) else []
    if not route_list:
        return _text(":police_car: No patrol routes configured")
    lines = [":police_car: *Patrol Routes*\n"]
    for r in route_list[:10]:
        lines.append(f"• *{r.get('name', '?')}* — status: `{r.get('status', '?')}`")
    return _text("\n".join(lines))


async def cmd_shifts(_args: str) -> dict:
    shifts = await _api("GET", "/api/shift-logbook/")
    shift_list = shifts if isinstance(shifts, list) else shifts.get("shifts", []) if isinstance(shifts, dict) else []
    if not shift_list:
        return _text(":spiral_calendar_pad: No active shifts")
    lines = [":spiral_calendar_pad: *Shifts*\n"]
    for s in shift_list[:10]:
        lines.append(f"• *{s.get('operator_name', s.get('name', '?'))}* — {s.get('status', '?')} | started: {str(s.get('started_at', '?'))[:19]}")
    return _text("\n".join(lines))


async def cmd_cases(_args: str) -> dict:
    cases = await _api("GET", "/api/cases?status=open&limit=10")
    case_list = cases if isinstance(cases, list) else cases.get("cases", []) if isinstance(cases, dict) else []
    if not case_list:
        return _text(":file_folder: No open cases")
    lines = [":file_folder: *Open Cases*\n"]
    for c in case_list[:10]:
        lines.append(f"• `{str(c.get('id', '?'))[:8]}` *{c.get('title', '?')}* — priority: `{c.get('priority', '?')}` | status: `{c.get('status', '?')}`")
    return _text("\n".join(lines))


async def cmd_sop(_args: str) -> dict:
    instances = await _api("GET", "/api/sop/instances")
    inst_list = instances if isinstance(instances, list) else instances.get("instances", []) if isinstance(instances, dict) else []
    if not inst_list:
        return _text(":bookmark_tabs: No active SOP instances")
    lines = [":bookmark_tabs: *Active SOP Instances*\n"]
    for s in inst_list[:10]:
        lines.append(f"• `{str(s.get('id', '?'))[:8]}` *{s.get('template_name', s.get('name', '?'))}* — step: {s.get('current_step', '?')}/{s.get('total_steps', '?')} | status: `{s.get('status', '?')}`")
    return _text("\n".join(lines))


# ── Analytics commands ────────────────────────────────────────

async def cmd_analytics(args: str) -> dict:
    sub = args.strip().split()[0] if args.strip() else ""

    if sub == "events":
        data = await _api("GET", "/api/analytics/events-over-time?hours=24")
        items = data if isinstance(data, list) else data.get("data", []) if isinstance(data, dict) else []
        total = sum(d.get("count", 0) for d in items) if items else 0
        return _text(f":chart_with_upwards_trend: *Events (24h):* {total} total events across {len(items)} intervals")

    elif sub == "severity":
        data = await _api("GET", "/api/analytics/alerts-by-severity")
        if isinstance(data, dict):
            lines = [":bar_chart: *Alerts by Severity*\n"]
            for sev in ["critical", "high", "medium", "low", "info"]:
                count = data.get(sev, 0)
                emoji = SEVERITY_EMOJI.get(sev, ":white_circle:")
                bar = ":black_large_square:" * min(count, 20)
                lines.append(f"{emoji} {sev}: *{count}* {bar}")
            return _text("\n".join(lines))

    elif sub == "zones":
        data = await _api("GET", "/api/analytics/zone-occupancy")
        items = data if isinstance(data, list) else data.get("zones", []) if isinstance(data, dict) else []
        if not items:
            return _text(":world_map: No zone occupancy data")
        lines = [":world_map: *Zone Occupancy*\n"]
        for z in items[:10]:
            name = z.get("zone_name", z.get("name", "?"))
            count = z.get("current_count", z.get("count", 0))
            lines.append(f"• *{name}*: {count} people")
        return _text("\n".join(lines))

    return _text(":x: Usage: `/sentinel analytics events|severity|zones`")


# ── Search command ────────────────────────────────────────────

async def cmd_search(args: str) -> dict:
    if not args:
        return _text(":x: Usage: `/sentinel search <query>`")
    result = await _api("POST", "/api/search/semantic", {"query": args.strip(), "limit": 5})
    results = result.get("results", []) if isinstance(result, dict) else (result if isinstance(result, list) else [])
    if not results:
        return _text(f":mag: No results for: _{args.strip()}_")
    lines = [f":mag: *Search: {args.strip()}*\n"]
    for r in results[:5]:
        score = r.get("score", r.get("similarity", 0))
        desc = r.get("description", r.get("text", r.get("title", "?")))[:100]
        lines.append(f"• ({score:.2f}) _{desc}_")
    return _text("\n".join(lines))


# ── Webhook commands ──────────────────────────────────────────

async def cmd_webhooks(_args: str) -> dict:
    wh = await _api("GET", "/api/webhooks")
    wh_list = wh.get("webhooks", []) if isinstance(wh, dict) else (wh if isinstance(wh, list) else [])
    if not wh_list:
        return _text(":link: No webhooks configured")
    lines = [":link: *Webhooks*\n"]
    for w in wh_list:
        active = ":large_green_circle:" if w.get("is_active") else ":black_circle:"
        lines.append(f"{active} `{str(w.get('id', '?'))[:8]}` *{w.get('name', '?')}* — type: `{w.get('integration_type', '?')}` | last: `{w.get('last_status', 'never')}`")
    return _text("\n".join(lines))


async def cmd_webhook_test(args: str) -> dict:
    if not args:
        return _text(":x: Usage: `/sentinel webhook test <webhook_id>`")
    result = await _api("POST", f"/api/webhooks/{args.strip()}/test")
    if isinstance(result, dict):
        if result.get("success"):
            return _channel(f":white_check_mark: Webhook `{args.strip()[:8]}` test succeeded (HTTP {result.get('status_code', '?')})")
        return _text(f":x: Webhook test failed: {result.get('error', 'unknown error')}")
    return _text(":x: Could not test webhook")


# ── Site / Tamper / Environmental commands ────────────────────

async def cmd_sites(_args: str) -> dict:
    overview = await _api("GET", "/api/sites/overview")
    if isinstance(overview, dict):
        sites = overview.get("sites", [])
        lines = [":office: *Sites Overview*\n"]
        for s in (sites if isinstance(sites, list) else [overview])[:10]:
            lines.append(f"• *{s.get('name', '?')}* — cameras: {s.get('camera_count', '?')} | zones: {s.get('zone_count', '?')}")
        return _text("\n".join(lines))
    return _text(":office: Could not fetch sites overview")


async def cmd_tamper(_args: str) -> dict:
    status = await _api("GET", "/api/tamper/status")
    if isinstance(status, dict):
        return _text(
            f":eye: *Tamper Detection Status*\n"
            f"Baselines: *{status.get('baseline_count', '?')}*\n"
            f"Recent events: *{status.get('recent_events', '?')}*\n"
            f"Status: `{status.get('status', '?')}`"
        )
    return _text(":eye: Could not fetch tamper status")


async def cmd_environmental(_args: str) -> dict:
    stats = await _api("GET", "/api/environmental/stats")
    if isinstance(stats, dict):
        return _text(
            f":cloud: *Environmental Status*\n"
            f"Active hazards: *{stats.get('active_hazards', stats.get('active', '?'))}*\n"
            f"Total events: *{stats.get('total_events', stats.get('total', '?'))}*"
        )
    return _text(":cloud: Could not fetch environmental status")


# ── Command router ────────────────────────────────────────────

COMMANDS: dict[str, Any] = {
    "help": cmd_help,
    "status": cmd_status,
    "mode": cmd_mode,
    "performance": cmd_performance,
    "pending": cmd_pending,
    "cameras": cmd_cameras,
    "camera": cmd_camera_action,
    "alerts": cmd_alerts,
    "alert": cmd_alert_action,
    "agents": cmd_agents_bulk,
    "agent": cmd_agent_action,
    "zones": cmd_zones,
    "zone": cmd_zone_occupancy,
    "threats": cmd_threats,
    "threat-level": cmd_threat_level,
    "plates": cmd_plates,
    "plate": cmd_plate_search,
    "watchlist": cmd_watchlist,
    "reid": cmd_reid,
    "crowd": cmd_crowd,
    "patrol": cmd_patrol,
    "shifts": cmd_shifts,
    "cases": cmd_cases,
    "sop": cmd_sop,
    "analytics": cmd_analytics,
    "search": cmd_search,
    "webhooks": cmd_webhooks,
    "webhook": cmd_webhook_test,
    "sites": cmd_sites,
    "tamper": cmd_tamper,
    "environmental": cmd_environmental,
}

# Override for "agents" without args — show fleet, not bulk action
COMMANDS_NO_ARGS = {
    "agents": cmd_agents,
    "alert": cmd_alert_stats,
    "zone": cmd_zones,
    "plate": cmd_plates,
    "webhook": cmd_webhooks,
}


async def _route_command(text: str) -> dict:
    """Parse and route a slash command."""
    text = text.strip()
    if not text:
        return await cmd_help("")

    parts = text.split(None, 1)
    cmd = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""

    # Special routing: no-args variants
    if not args and cmd in COMMANDS_NO_ARGS:
        return await COMMANDS_NO_ARGS[cmd](args)

    # Special: "alert stats" sub-command
    if cmd == "alert" and args.strip() == "stats":
        return await cmd_alert_stats("")

    handler = COMMANDS.get(cmd)
    if handler:
        return await handler(args)

    return _text(f":x: Unknown command `{cmd}`. Type `/sentinel help` for available commands.")


# ── Endpoint ──────────────────────────────────────────────────

@router.post("/commands")
async def handle_slack_command(request: Request):
    """Receive Slack slash command and return response."""
    body = await request.body()

    # Verify Slack signature (if signing secret is configured)
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "0")
    signature = request.headers.get("X-Slack-Signature", "")
    if SLACK_SIGNING_SECRET and not _verify_slack_signature(body, timestamp, signature):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    # Parse form-encoded body
    form = await request.form()
    command_text = form.get("text", "")
    user_name = form.get("user_name", "unknown")
    channel = form.get("channel_name", "unknown")

    logger.info("slack.command user=%s channel=%s text=%s", user_name, channel, command_text)

    try:
        response = await _route_command(str(command_text))
        return JSONResponse(content=response)
    except Exception as exc:
        logger.exception("slack.command.error: %s", exc)
        return JSONResponse(content=_text(f":x: Error processing command: {str(exc)[:200]}"))


@router.post("/interactive")
async def handle_slack_interactive(request: Request):
    """Handle Slack interactive components (buttons, menus) — future use."""
    body = await request.body()
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "0")
    signature = request.headers.get("X-Slack-Signature", "")
    if SLACK_SIGNING_SECRET and not _verify_slack_signature(body, timestamp, signature):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    form = await request.form()
    payload = json.loads(form.get("payload", "{}"))
    logger.info("slack.interactive type=%s", payload.get("type"))
    return JSONResponse(content={"text": "Action received"})
