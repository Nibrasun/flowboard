"""Probe the upload-video protocol through the agent proxy (extension reloaded)."""
import json, time, httpx

BASE = "http://127.0.0.1:8101"
PROJ = "457f7b17-a08a-4a3f-8a2b-262ec465e039"
UP = "https://labs.google/fx/tools/flow/api/upload-video"


def proxy(label, url, method="POST", headers=None, body=None, body_b64=None):
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{BASE}/api/requests", json={
            "type": "proxy",
            "params": {"url": url, "method": method, "headers": headers or {}, "body": body, "bodyB64": body_b64},
        })
        if r.status_code != 200:
            print(f"[{label}] create failed {r.status_code}: {r.text[:150]}")
            return None
        rid = r.json()["id"]
        for _ in range(40):
            time.sleep(1)
            rr = c.get(f"{BASE}/api/requests/{rid}").json()
            if rr["status"] in ("done", "failed", "timeout", "canceled"):
                res = rr.get("result") or {}
                print(f"[{label}] -> {rr.get('error') or 'ok'}")
                print("   status:", res.get("status"))
                print("   headers:", json.dumps(res.get("headers") or {}, indent=None)[:400])
                print("   data:", str(res.get("data"))[:400])
                return res
        print(f"[{label}] poll timeout")
        return None


def main():
    # 1) start — guess: JSON metadata body
    proxy("start",
          f"{UP}?action=start",
          headers={"content-type": "application/json"},
          body={"fileName": "ref.mp4", "mimeType": "video/mp4",
                "size": 2753692, "projectId": PROJ})


main()
