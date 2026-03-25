from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.services.multi_site_service import multi_site_service

router = APIRouter(prefix="/api/multi-site", tags=["multi-site"])

@router.get("/hierarchy")
async def get_hierarchy(root_id: str = None, db: AsyncSession = Depends(get_db)):
    return await multi_site_service.get_hierarchy(db, root_id)

@router.post("/nodes")
async def create_node(data: dict, db: AsyncSession = Depends(get_db)):
    return await multi_site_service.create_node(db, data)

@router.get("/nodes/{node_id}")
async def get_node(node_id: str, db: AsyncSession = Depends(get_db)):
    n = await multi_site_service.get_node(db, node_id)
    if not n:
        raise HTTPException(404, "Node not found")
    return n

@router.put("/nodes/{node_id}")
async def update_node(node_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    try:
        return await multi_site_service.update_node(db, node_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))

@router.delete("/nodes/{node_id}")
async def delete_node(node_id: str, db: AsyncSession = Depends(get_db)):
    if not await multi_site_service.delete_node(db, node_id):
        raise HTTPException(404, "Node not found")
    return {"deleted": True}

@router.get("/overview")
async def global_overview(db: AsyncSession = Depends(get_db)):
    return await multi_site_service.get_global_overview(db)

@router.get("/sites/{site_id}/dashboard")
async def site_dashboard(site_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await multi_site_service.get_site_dashboard(db, site_id)
    except ValueError as e:
        raise HTTPException(404, str(e))

@router.get("/correlation")
async def cross_site_correlation(hours: int = 1, db: AsyncSession = Depends(get_db)):
    return await multi_site_service.cross_site_correlation(db, hours)

@router.post("/comparison")
async def site_comparison(data: dict, db: AsyncSession = Depends(get_db)):
    return await multi_site_service.get_site_comparison(db, data["site_ids"])
