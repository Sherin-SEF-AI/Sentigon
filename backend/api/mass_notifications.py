from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.mass_notification_service import mass_notification_service

router = APIRouter(prefix="/api/notifications/mass", tags=["mass-notifications"])

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.get_stats(db)

@router.post("/send")
async def send_notification(data: dict, db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.send_notification(db, data)

@router.get("/")
async def list_notifications(limit: int = 50, offset: int = 0, db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.get_notifications(db, limit, offset)

@router.get("/templates")
async def list_templates(category: str = None, db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.get_templates(db, category)

@router.post("/templates")
async def create_template(data: dict, db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.create_template(db, data)

@router.put("/templates/{template_id}")
async def update_template(template_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await mass_notification_service.update_template(db, template_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, db: AsyncSession = Depends(get_db)):
    if not await mass_notification_service.delete_template(db, template_id):
        raise HTTPException(404, "Template not found")
    return {"deleted": True}

@router.post("/lockdown/activate")
async def activate_lockdown(data: dict, db: AsyncSession = Depends(get_db)):
    return await mass_notification_service.activate_lockdown(db, data.get("sequence_id"), data.get("custom_steps"), data.get("activated_by"))

@router.post("/lockdown/deactivate")
async def deactivate_lockdown(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await mass_notification_service.deactivate_lockdown(db, data["lockdown_id"], data.get("deactivated_by"))
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/lockdown/active")
async def active_lockdowns():
    return await mass_notification_service.get_active_lockdowns()

# Must be LAST — catches /{notification_id} which would shadow /templates, /lockdown, /stats etc.
@router.get("/{notification_id}")
async def get_notification(notification_id: str, db: AsyncSession = Depends(get_db)):
    n = await mass_notification_service.get_notification(db, notification_id)
    if not n:
        raise HTTPException(404, "Notification not found")
    return n

@router.post("/{notification_id}/acknowledge")
async def acknowledge(notification_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await mass_notification_service.acknowledge(db, notification_id, data["user_id"])
    except ValueError as e:
        raise HTTPException(400, str(e))
