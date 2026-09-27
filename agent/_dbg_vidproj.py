"""Direct upload_video against the real UI project id."""
import asyncio
import json
import sys

sys.path.insert(0, "D:/Application/Google Flow/flowboard/agent")

from flowboard.services.flow_sdk import get_flow_sdk

VID = r"D:\Application\Google Flow\flowboard\docs\assets\flowboard-intro.mp4"
PROJ = "8422fbfb-99ee-43f7-af9c-15e0cdcbbb72"


async def main():
    raw = open(VID, "rb").read()
    sdk = get_flow_sdk()
    resp = await sdk.upload_video(video_bytes=raw, mime_type="video/mp4",
                                  project_id=PROJ, file_name="ref.mp4")
    print("media_id:", resp.get("media_id"))
    print("error:", resp.get("error"), "stage:", resp.get("stage"))
    print("raw:", json.dumps(resp.get("raw"))[:600])


asyncio.run(main())
