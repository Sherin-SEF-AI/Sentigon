from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.soc_workspace_service import soc_workspace_service

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

@router.get("/")
async def get_workspace(user_id: str = Query(...), db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_workspace(db, user_id)

@router.put("/")
async def save_workspace(data: dict, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.save_workspace(db, data["user_id"], data)

@router.post("/reset")
async def reset_workspace(data: dict, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.reset_workspace(db, data["user_id"])

@router.get("/widgets")
async def available_widgets():
    return soc_workspace_service.get_available_widgets()

@router.get("/widgets/{widget_type}/data")
async def widget_data(widget_type: str, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_widget_data(db, widget_type)

@router.get("/shift-briefing")
async def shift_briefing(db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.generate_shift_briefing(db)

@router.get("/operator-metrics")
async def operator_metrics(user_id: str = None, days: int = 7, db: AsyncSession = Depends(get_db)):
    return await soc_workspace_service.get_operator_metrics(db, user_id, days)


@router.post("/widgets/QuickActions/action")
async def quick_action(data: dict, db: AsyncSession = Depends(get_db)):
    """Execute a QuickActions widget action against real services.

    Supported actions: ack_all (acknowledge all NEW alerts), lockdown
    (activate facility lockdown), all_clear (release active lockdowns),
    refresh (client-side data refresh). Unknown actions are honestly reported
    as unsupported.
    """
    action = (data or {}).get("action", "")
    params = (data or {}).get("params", {}) or {}

    try:
        if action == "ack_all":
            from sqlalchemy import select, update
            from backend.models.models import Alert, AlertStatus
            from datetime import datetime, timezone
            rows = await db.execute(select(Alert).where(Alert.status == AlertStatus.NEW))
            count = 0
            for alert in rows.scalars().all():
                alert.status = AlertStatus.ACKNOWLEDGED
                alert.acknowledged_at = datetime.now(timezone.utc)
                count += 1
            await db.commit()
            return {"status": "ok", "action": action, "acknowledged": count}

        elif action == "lockdown":
            from backend.services.mass_notification_service import mass_notification_service
            result = await mass_notification_service.activate_lockdown(
                db, custom_steps=params.get("steps", []),
            )
            return {"status": "ok", "action": action, "result": result}

        elif action == "all_clear":
            from backend.services.mass_notification_service import mass_notification_service
            active = await mass_notification_service.get_active_lockdowns()
            cleared = []
            for ld in active:
                res = await mass_notification_service.deactivate_lockdown(db, ld.get("id"))
                cleared.append(res)
            return {"status": "ok", "action": action, "cleared": len(cleared), "results": cleared}

        elif action == "refresh":
            return {"status": "ok", "action": action, "message": "refresh acknowledged"}

        return {"status": "unsupported", "action": action}
    except Exception as e:
        return {"status": "error", "action": action, "error": str(e)}
