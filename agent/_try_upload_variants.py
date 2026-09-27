"""Try alternate uploadImage body shapes for video to find what Flow accepts."""
import asyncio, base64, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flowboard.services.flow_client import flow_client

VID = r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4"
PROJ = "457f7b17-a08a-4a3f-8a2b-262ec465e039"


async def try_body(name: str, body: dict):
    print(f"\n=== {name} ===")
    try:
        resp = await flow_client.api_request(
            url="https://aisandbox-pa.googleapis.com/v1/flow/uploadImage",
            method="POST",
            headers={"content-type": "application/json"},
            body=body,
        )
        if isinstance(resp, dict) and resp.get("error"):
            print("ERROR:", resp["error"])
            raw = resp.get("raw") or {}
            print("raw status:", raw.get("status") if isinstance(raw, dict) else "?")
            print("raw body:", json.dumps(raw)[:300])
            return None
        media = resp.get("data", {}).get("media", {})
        mid = media.get("name") if isinstance(media, dict) else None
        print("MEDIA_ID:", mid)
        return mid
    except Exception as e:
        print("EXC:", type(e).__name__, str(e)[:200])
        return None


async def main():
    raw = open(VID, "rb").read()
    b64 = base64.b64encode(raw).decode("ascii")
    print("video bytes:", len(raw))

    base = {
        "clientContext": {"projectId": PROJ, "tool": "PINHOLE"},
        "fileName": "ref.mp4",
        "isHidden": False,
        "isUserUploaded": True,
        "mimeType": "video/mp4",
    }

    # A: imageBytes (what we already tried -> INVALID_ARGUMENT)
    await try_body("A: imageBytes", {**base, "imageBytes": b64})
    # B: videoBytes
    await try_body("B: videoBytes", {**base, "videoBytes": b64})
    # C: mediaBytes
    await try_body("C: mediaBytes", {**base, "mediaBytes": b64})
    # D: imageBytes + mediaType VIDEO
    await try_body("D: imageBytes+mediaType", {**base, "imageBytes": b64, "mediaType": "VIDEO"})
    # E: videoBytes + mediaType
    await try_body("E: videoBytes+mediaType", {**base, "videoBytes": b64, "mediaType": "VIDEO"})


asyncio.run(main())
