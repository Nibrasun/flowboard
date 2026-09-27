import asyncio
import glob
import httpx

BASE = "http://127.0.0.1:8101"


async def main():
    async with httpx.AsyncClient(timeout=180) as c:
        # 1. ensure project for board 1
        r = await c.post(f"{BASE}/api/boards/1/project")
        print("project:", r.status_code, r.text[:200])
        proj = r.json()["flow_project_id"]

        # 2. upload the reference video through the NEW video path
        vid_path = r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4"
        with open(vid_path, "rb") as f:
            r2 = await c.post(
                f"{BASE}/api/upload",
                data={"project_id": proj},
                files={"file": ("flowboard-intro.mp4", f, "video/mp4")},
            )
        print("upload video:", r2.status_code)
        body = r2.json()
        print("video body:", json_dumps(body)[:400])
        vid_media_id = body.get("media_id")

        # 3. upload a reference image (png from the media cache)
        img = sorted(glob.glob(r"D:\Application\Google Flow\flowboard\storage\media\*.png"))[0]
        with open(img, "rb") as f:
            r3 = await c.post(
                f"{BASE}/api/upload",
                data={"project_id": proj},
                files={"file": ("ref.png", f, "image/png")},
            )
        print("upload img:", r3.status_code)
        img_media_id = r3.json().get("media_id")
        print("img body:", json_dumps(r3.json())[:300])

        print("\nRESULT_PROJECT=", proj)
        print("RESULT_VIDEO_MEDIA_ID=", vid_media_id)
        print("RESULT_IMG_MEDIA_ID=", img_media_id)


def json_dumps(o):
    import json
    return json.dumps(o, indent=None)


asyncio.run(main())
