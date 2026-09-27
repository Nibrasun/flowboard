import base64, json, time, httpx

BASE = "http://127.0.0.1:8101"
VID = r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4"
PROJ = "457f7b17-a08a-4a3f-8a2b-262ec465e039"

raw = open(VID, "rb").read()
b64 = base64.b64encode(raw).decode("ascii")
body = {
    "clientContext": {"projectId": PROJ, "tool": "PINHOLE"},
    "fileName": "ref.mp4",
    "isHidden": False,
    "isUserUploaded": True,
    "mimeType": "video/mp4",
    "imageBytes": b64,
}

with httpx.Client(timeout=60) as c:
    r = c.post(f"{BASE}/api/requests", json={
        "type": "proxy",
        "params": {
            "url": "https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": body,
        },
    })
    rid = r.json()["id"]
    for _ in range(30):
        time.sleep(1)
        rr = c.get(f"{BASE}/api/requests/{rid}").json()
        if rr["status"] in ("done", "failed", "timeout", "canceled"):
            print("STATUS:", rr["status"])
            print("ERROR:", rr.get("error"))
            print("RESULT RAW:", json.dumps(rr.get("result"), indent=1)[:1500])
            break
