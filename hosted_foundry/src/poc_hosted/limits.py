"""Bound response-request bytes before the protocol library parses JSON."""

import asyncio


class RequestBodyLimit:
    def __init__(self, app, max_bytes=4096):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            return await self.app(scope, receive, send)
        chunks = []
        size = 0
        try:
            async with asyncio.timeout(10):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body = message.get("body", b"")
                    size += len(body)
                    if size > self.max_bytes:
                        await self.reject(send, 413)
                        return
                    chunks.append(body)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            await self.reject(send, 408)
            return
        delivered = False

        async def limited_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, limited_receive, send)

    @staticmethod
    async def reject(send, status):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"error":"Request limit exceeded."}'})
