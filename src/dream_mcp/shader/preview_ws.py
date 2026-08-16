"""Rendering over the preview WebSocket.

The file-request transport reaches the same `RenderMaterialPreview` code, but measured on
2026-08-16 it returns the render context's *first* frame, which is the engine's default
material rather than yours -- a pure-red material comes back a grey WorldGridMaterial
sphere, and red and blue come back byte-identical. The same material over this transport
comes back correct. Until that is resolved on the plugin side, preview goes through here.

It is also the better channel on its own merits: the frame arrives as bytes on the socket,
so nothing touches `preview.json` -- a single file every transport overwrites, which the
file path had to guard against with a request-id check that could still lose a race.
"""

from __future__ import annotations

import asyncio
import json
import struct

#: Fixed in the plugin; there is no setting for it.
ENDPOINT = "ws://127.0.0.1:17864"

#: Outbound frames are [length uint32 LE][tag u8][payload]; 1 = UTF-8 JSON, 2 = raw PNG.
TAG_JSON = 1
TAG_PNG = 2

MAX_FRAME_BYTES = 64 * 1024 * 1024


class PreviewSocketError(Exception):
    pass


def _unwrap(payload: bytes) -> tuple[int, bytes]:
    if len(payload) < 5:
        raise PreviewSocketError(f"Truncated frame: {len(payload)} bytes.")
    length = struct.unpack("<I", payload[:4])[0]
    return payload[4], payload[5:4 + length]


async def _render(source_file: str, mesh: str, width: int, height: int,
                  request_id: str, timeout: float) -> tuple[dict, bytes]:
    try:
        import websockets
    except ImportError as error:  # pragma: no cover - dependency is declared
        raise PreviewSocketError(
            "The websockets package is missing; reinstall dream-mcp."
        ) from error

    try:
        connection = await asyncio.wait_for(
            websockets.connect(ENDPOINT, max_size=MAX_FRAME_BYTES), timeout=15)
    except (OSError, asyncio.TimeoutError) as error:
        raise PreviewSocketError(
            f"Could not reach the preview server at {ENDPOINT}: {error}. It only listens "
            f"while the editor is running, and a second editor instance holding the port "
            f"leaves it unavailable with only a warning in the log."
        ) from error

    async with connection as socket:
        await socket.send(json.dumps({
            "type": "previewMaterial",
            "sourceFile": source_file,
            "mesh": mesh,
            "width": width,
            "height": height,
            "requestId": request_id,
            # PNG rather than the RawRGBA8 default: this is a one-shot still, and the raw
            # encoding exists for streaming clients that decode frames themselves.
            "encoding": "png",
            "stream": False,
        }))

        result: dict | None = None
        deadline = asyncio.get_running_loop().time() + timeout

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise PreviewSocketError(
                    f"No frame within {timeout:.0f}s. The editor may be busy compiling.")
            try:
                message = await asyncio.wait_for(socket.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                raise PreviewSocketError(f"No frame within {timeout:.0f}s.") from None

            if isinstance(message, str):
                # Unparsable requests get a plain-text error reply rather than a framed one.
                raise PreviewSocketError(message[:400])

            tag, body = _unwrap(message)
            if tag == TAG_JSON:
                payload = json.loads(body.decode("utf-8"))
                if payload.get("type") == "previewResult":
                    if payload.get("status") != "ready":
                        raise PreviewSocketError(
                            payload.get("message") or "The preview failed.")
                    result = payload
                # probeState and previewFrame metadata both arrive here; the PNG that
                # follows is what we are waiting for.
                continue

            if tag == TAG_PNG:
                if result is None:
                    raise PreviewSocketError(
                        "A frame arrived before its result; the protocol pairs them by "
                        "arrival order, so something else is writing to this connection.")
                return result, body

            raise PreviewSocketError(f"Unknown frame tag {tag}.")


def render(source_file: str, mesh: str = "sphere", width: int = 512, height: int = 512,
           request_id: str = "dream-mcp", timeout: float = 180.0) -> tuple[dict, bytes]:
    """Returns (previewResult, png bytes). Synchronous wrapper for the MCP tool."""
    return asyncio.run(_render(source_file, mesh, width, height, request_id, timeout))
