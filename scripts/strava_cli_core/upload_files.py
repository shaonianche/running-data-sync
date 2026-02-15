from __future__ import annotations

import asyncio
import os
from pathlib import Path

from ..exceptions import SyncError
from ..garmin_sync import Garmin
from ..utils import get_logger
from .types import GarminCredentials

logger = get_logger(__name__)

SUPPORTED_GARMIN_UPLOAD_EXTS = {".fit", ".gpx", ".tcx"}


def collect_activity_files(paths: list[Path], recursive: bool = False) -> list[Path]:
    collected: list[Path] = []
    for path in paths:
        if not path.exists():
            raise ValueError(f"Path does not exist: {path}")

        if path.is_file():
            if path.suffix.lower() in SUPPORTED_GARMIN_UPLOAD_EXTS:
                collected.append(path)
            continue

        walker = path.rglob("*") if recursive else path.glob("*")
        for item in walker:
            if item.is_file() and item.suffix.lower() in SUPPORTED_GARMIN_UPLOAD_EXTS:
                collected.append(item)

    unique_files = sorted({file.resolve() for file in collected})
    if not unique_files:
        raise ValueError("No uploadable files found. Supported extensions: .fit, .gpx, .tcx")
    return unique_files


async def run_upload_files_to_garmin(
    *,
    garmin_credentials: GarminCredentials,
    paths: list[Path],
    recursive: bool = False,
) -> None:
    files = collect_activity_files(paths, recursive=recursive)
    auth_domain = "CN" if garmin_credentials.is_cn else ""
    client = Garmin(garmin_credentials.secret_string, auth_domain)

    failures: list[str] = []
    try:
        logger.info("Uploading %d activity files to Garmin.", len(files))
        for file_path in files:
            try:
                with open(file_path, "rb") as file_obj:
                    body = file_obj.read()
                payload = {"file": (os.path.basename(file_path), body)}
                response = await client.req.post(client.upload_url, files=payload, headers=client.headers)
                response.raise_for_status()
                logger.info("Uploaded: %s", file_path)
            except Exception as exc:
                failures.append(str(file_path))
                logger.error("Failed uploading %s: %s", file_path, exc, exc_info=True)
    finally:
        if not client.req.is_closed:
            await client.req.aclose()

    if failures:
        raise SyncError(f"Failed to upload {len(failures)} file(s): {', '.join(failures[:5])}")


def run_upload_files_to_garmin_sync(
    *,
    garmin_credentials: GarminCredentials,
    paths: list[Path],
    recursive: bool = False,
) -> None:
    asyncio.run(
        run_upload_files_to_garmin(
            garmin_credentials=garmin_credentials,
            paths=paths,
            recursive=recursive,
        )
    )

