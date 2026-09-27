"""Probe: resumable initiation at /upload/v1/flow/uploadImage (standard Google protocol)."""
import json
import time

import httpx

BASE = "http://127.0.0.1:8101"
PROJ = "457f7b17-a08a-4a3f-8a2b-262ec465e039"


def proxy(label, url, headers, body):
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{BASE}/api/requests", json={"type": "proxy", "params": {
            "url": url, "method": "POST", "headers": headers, "body": body}})
        rid = r.json()["id"]
        for _ in range(30):
            time.sleep(2)
            rr = c.get(f"{BASE}/api/requests/{rid}").json()
            if rr["status"] in ("done", "failed", "timeout", "canceled"):
                res = rr.get("result") or {}
                print(f"[{label}] {rr.get('error') or 'ok'} status={res.get('status')}")
                print("  headers:", json.dumps(res.get("headers") or {}, indent=None)[:500])
                print("  data:", str(res.get("data"))[:500])
                return res
        print(f"[{label}] poll timeout")
        return None


proxy("resumable-start",
      "https://aisandbox-pa.googleapis.com/upload/v1/flow/uploadImage",
      {"content-type": "application/json",
       "X-Goog-Upload-Protocol": "resumable",
       "X-Goog-Upload-Command": "start",
       "X-Goog-Upload-Header-Content-Length": "2753692",
       "X-Goog-Upload-Header-Content-Type": "video/mp4"},
      {"clientContext": {"projectId": PROJ, "tool": "PINHOLE"},
       "fileName": "ref.mp4", "mimeType": "video/mp4"})
