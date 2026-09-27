"""POST mp4 to /api/upload, dump FULL error detail (headers included)."""
import json

import httpx

with httpx.Client(timeout=300) as c:
    with open(r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4", "rb") as f:
        r = c.post(
            "http://127.0.0.1:8101/api/upload",
            data={"project_id": "8422fbfb-99ee-43f7-af9c-15e0cdcbbb72"},
            files={"file": ("ref.mp4", f, "video/mp4")},
        )
    d = r.json()
    raw = (d.get("detail") or {}).get("raw") or {}
    print("message:", (d.get("detail") or {}).get("message"))
    print("status:", raw.get("status"))
    print("data:", str(raw.get("data"))[:300])
    print("headers:", json.dumps(raw.get("headers"), indent=1))
