"""AI service entry point. Phase 1 exposes a health endpoint only (TRD 7.2)."""

from fastapi import FastAPI
from pydantic import BaseModel


class Health(BaseModel):
    status: str
    service: str


app = FastAPI(title="erase-ai", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    return Health(status="ok", service="erase-ai")
