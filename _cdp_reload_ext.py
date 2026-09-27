"""Check extension path (sentinel) + force reload via CDP."""
import asyncio, json, websockets

WS = "ws://127.0.0.1:9222/devtools/browser"
EXT = "efokakfkpkhfknlglhfbfgeakijcgmcp"  # Flowboard Bridge (not the old Flow Kit fork)


async def rpc(ws, sid, mid, method, params=None):
    await ws.send(json.dumps({"id": mid, "sessionId": sid, "method": method, "params": params or {}}))
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
        if m.get("id") == mid:
            return m


async def main():
    async with websockets.connect(WS, open_timeout=5) as ws:
        r = json.loads(await asyncio.wait_for(ws.recv(), timeout=5)) if False else None
        await ws.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
        r = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        sw = next(t for t in r["result"]["targetInfos"]
                  if t["type"] == "service_worker" and EXT in t.get("url", ""))
        print("SW:", sw["url"][:70])

        await ws.send(json.dumps({"id": 2, "method": "Target.attachToTarget",
                                  "params": {"targetId": sw["targetId"], "flatten": True}}))
        session = None
        while session is None:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if m.get("method") == "Target.attachedToTarget":
                session = m["params"]["sessionId"]

        # 1) sentinel: is the loaded folder the one we edited?
        resp = await rpc(ws, session, 10, "Runtime.evaluate", {
            "expression": "fetch(chrome.runtime.getURL('__sentinel__.txt')).then(r=>r.status).catch(e=>'ERR')",
            "awaitPromise": True, "returnByValue": True})
        print("sentinel:", resp["result"]["result"].get("value"))

        # 2) manifest version + background.js size as fingerprint
        resp = await rpc(ws, session, 11, "Runtime.evaluate", {
            "expression": "JSON.stringify({v: chrome.runtime.getManifest().version})",
            "returnByValue": True})
        print("manifest:", resp["result"]["result"].get("value"))

        # 3) reload
        resp = await rpc(ws, session, 12, "Runtime.evaluate", {
            "expression": "chrome.runtime.reload(); 'ok'", "returnByValue": True})
        print("reload:", resp["result"]["result"].get("value"))

        # 4) reload of the extension does NOT re-inject content scripts into
        # already-open tabs — refresh any open Flow tab so it re-injects.
        await ws.send(json.dumps({"id": 20, "method": "Target.getTargets"}))
        r = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        flow_tabs = [t for t in r["result"]["targetInfos"]
                     if t["type"] == "page" and ("flow.google.com" in t.get("url", "")
                                                  or "labs.google" in t.get("url", ""))]
        for t in flow_tabs:
            await ws.send(json.dumps({"id": 21, "method": "Target.attachToTarget",
                                      "params": {"targetId": t["targetId"], "flatten": True}}))
            tab_session = None
            while tab_session is None:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if m.get("method") == "Target.attachedToTarget":
                    tab_session = m["params"]["sessionId"]
            await rpc(ws, tab_session, 22, "Page.reload")
            print("reloaded tab:", t["url"][:70])

asyncio.run(main())
