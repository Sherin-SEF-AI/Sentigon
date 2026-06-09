from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.siem_service import siem_service

router = APIRouter(prefix="/api/integrations", tags=["integrations"])

@router.get("/stats")
async def get_stats(db: AsyncSession = Depends(get_db)):
    return await siem_service.get_stats(db)

@router.get("/connectors")
async def list_connectors(db: AsyncSession = Depends(get_db)):
    return await siem_service.get_connectors(db)

@router.post("/connectors")
async def create_connector(data: dict, db: AsyncSession = Depends(get_db)):
    return await siem_service.create_connector(db, data)

@router.get("/connectors/{connector_id}")
async def get_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    c = await siem_service.get_connector(db, connector_id)
    if not c:
        raise HTTPException(404, "Connector not found")
    return c

@router.put("/connectors/{connector_id}")
async def update_connector(connector_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await siem_service.update_connector(db, connector_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/connectors/{connector_id}")
async def delete_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    if not await siem_service.delete_connector(db, connector_id):
        raise HTTPException(404, "Connector not found")
    return {"deleted": True}

@router.post("/connectors/{connector_id}/test")
async def test_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await siem_service.test_connector(db, connector_id)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.get("/connectors/{connector_id}/logs")
async def get_logs(connector_id: str, limit: int = 50, db: AsyncSession = Depends(get_db)):
    return await siem_service.get_delivery_logs(db, connector_id, limit)

@router.post("/deliver")
async def deliver_event(data: dict, db: AsyncSession = Depends(get_db)):
    return await siem_service.deliver_event(db, data)


# ── Typed integration setup (onboarding) — register a connector of a category ──

async def _create_categorized(db, category: str, default_name: str, data: dict):
    payload = {"category": category, "name": data.get("name", default_name), **data}
    try:
        return await siem_service.create_connector(db, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/siem")
async def configure_siem(data: dict, db: AsyncSession = Depends(get_db)):
    return await _create_categorized(db, "siem", "SIEM", data)


@router.post("/access-control")
async def configure_access_control(data: dict, db: AsyncSession = Depends(get_db)):
    return await _create_categorized(db, "access_control", "Access Control", data)


@router.post("/pa-system")
async def configure_pa_system(data: dict, db: AsyncSession = Depends(get_db)):
    return await _create_categorized(db, "pa_system", "PA System", data)


@router.post("/{connector_id}/retry")
async def retry_connector(connector_id: str, db: AsyncSession = Depends(get_db)):
    """Retry a connector by re-running its connection test/delivery."""
    try:
        return await siem_service.test_connector(db, connector_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
