"""Probe: mp4 bytes to uploadImage with minimal body (gflow-style)."""
import base64
import json
import time

import httpx

BASE = "http://127.0.0.1:8101"
PROJ = "457f7b17-a08a-4a3f-8a2b-262ec465e039"
VID = r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4"

raw = open(VID, "rb").read()
print("size:", len(raw))
b64 = base64.b64encode(raw).decode("ascii")
body = {
    "clientContext": {"projectId": PROJ, "tool": "PINHOLE"},
    "imageBytes": b64,
}

with httpx.Client(timeout=120) as c:
    r = c.post(
        f"{BASE}/api/requests",
        json={"type": "proxy", "params": {
            "url": "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": body,
        }},
    )
    rid = r.json()["id"]
    for _ in range(60):
        time.sleep(2)
        rr = c.get(f"{BASE}/api/requests/{rid}").json()
        if rr["status"] in ("done", "failed", "timeout", "canceled"):
            print("STATUS:", rr["status"], "ERROR:", rr.get("error"))
            print("RESULT:", json.dumps(rr.get("result"), indent=1)[:1200])
            break
