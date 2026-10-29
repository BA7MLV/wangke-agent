#!/usr/bin/env python3
"""Publish a staged artifact without overwriting existing workspace files.

Usage: wangke-save /tmp/plot.png '函数分析/正弦函数对比.png'
The source is retained. Identical content at the requested/numbered path is reused.
This is an accidental-overwrite guard, not a restriction on arbitrary Python code.
"""
import argparse
import hashlib
import json
import os
from pathlib import PurePosixPath
import re
import stat
import unicodedata
import uuid

LIMIT = 20 * 1024 * 1024
EXTENSIONS = {"png": (".png",), "jpeg": (".jpg", ".jpeg"), "gif": (".gif",), "webp": (".webp",)}


def raster_format(header):
    if len(header) >= 24 and header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR":
        return "png"
    if len(header) >= 4 and header[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if len(header) >= 13 and header[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(header) >= 16 and header[:4] == b"RIFF" and header[8:12] == b"WEBP" and header[12:16] in (b"VP8 ", b"VP8L", b"VP8X"):
        return "webp"


def safe_name(name, image_format):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', "_", unicodedata.normalize("NFC", name)).strip().rstrip(". ")
    name = name or "Artifact"
    extension = os.path.splitext(name)[1]
    if image_format and extension.lower() not in EXTENSIONS[image_format]:
        name = (name[:-len(extension)] if extension else name) + EXTENSIONS[image_format][0]
    elif not image_format and extension.lower() in sum(EXTENSIONS.values(), ()):
        raise ValueError("invalid_image_format")
    stem, extension = os.path.splitext(name)
    if re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name, re.I):
        stem = "_" + stem
    extension = extension.encode("utf-8")[:32].decode("utf-8", "ignore")
    return stem.encode("utf-8")[:240 - len(extension.encode("utf-8"))].decode("utf-8", "ignore") + extension


def existing_matches(directory, name, size, digest):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except (FileNotFoundError, IsADirectoryError):
        return False
    except OSError:
        return False  # A symlink or unreadable entry must never be followed/replaced.
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != size:
            return False
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(65536), b""):
            hasher.update(chunk)
        after = os.fstat(stream.fileno())
        # Another publisher may still be unlinking its staging hard link. That
        # changes ctime/nlink, not the completed bytes, and must not create (2).
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        return (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns) and (current.st_dev, current.st_ino) == (after.st_dev, after.st_ino) and hasher.hexdigest() == digest


def publish(source, target, workspace="/workspace", on_conflict="rename"):
    if target.startswith("/workspace/"):
        target = target[len("/workspace/"):]
    parts = target.split("/")
    if not target or len(target) > 2048 or any(p in ("", ".", "..") or (i < len(parts) - 1 and len(p.encode("utf-8")) > 255) or re.search(r"[\\\x00-\x1f\x7f]", p) for i, p in enumerate(parts)):
        raise ValueError("invalid_workspace_path")
    descriptors = []
    temporary = None
    try:
        directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in parts[:-1]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(source_fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= LIMIT:
                raise ValueError("workspace_file_too_large_or_invalid")
            name = safe_name(parts[-1], raster_format(stream.read(32)))
            stream.seek(0)
            candidate_temp = ".save-" + str(uuid.uuid4())
            fd = os.open(candidate_temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
            temporary = candidate_temp
            size, hasher = 0, hashlib.sha256()
            with os.fdopen(fd, "wb") as output:
                for chunk in iter(lambda: stream.read(65536), b""):
                    size += len(chunk)
                    if size > LIMIT:
                        raise ValueError("workspace_file_too_large_or_invalid")
                    output.write(chunk)
                    hasher.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            after = os.fstat(stream.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("source_file_changed")
        digest = hasher.hexdigest()
        stem, extension = os.path.splitext(name)
        if on_conflict == "rename":
            # Reuse a later numbered artifact even when an earlier version was
            # deleted, rather than filling the gap with a duplicate on retry.
            numbered = re.compile(re.escape(stem) + r" \(([2-9]|[1-9][0-9]+)\)" + re.escape(extension) + r"\Z")
            candidates = []
            for entry in os.listdir(directory):
                match = numbered.fullmatch(entry)
                if entry == name:
                    candidates.append((1, entry))
                elif match:
                    candidates.append((int(match[1]), entry))
            for _, candidate in sorted(candidates):
                if existing_matches(directory, candidate, size, digest):
                    return {"path": str(PurePosixPath(*parts[:-1], candidate)), "sizeBytes": size, "sha256": digest, "reused": True}
        for number in range(1, 5001):
            candidate = name if number == 1 else f"{stem} ({number}){extension}"
            try:
                # link is atomic and fails if ANY entry already occupies this name.
                os.link(temporary, candidate, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                reused = False
            except FileExistsError:
                if existing_matches(directory, candidate, size, digest):
                    reused = True
                elif on_conflict == "error":
                    raise FileExistsError("workspace_file_exists")
                else:
                    continue
            os.unlink(temporary, dir_fd=directory)
            temporary = None
            os.fsync(directory)
            return {"path": str(PurePosixPath(*parts[:-1], candidate)), "sizeBytes": size, "sha256": digest, "reused": reused}
        raise ValueError("too_many_filename_conflicts")
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=descriptors[-1])
        for fd in reversed(descriptors):
            os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Staged source, e.g. /tmp/plot.png; never deleted")
    parser.add_argument("target", help="Meaningful workspace-relative destination")
    parser.add_argument("--on-conflict", choices=("rename", "error"), default="rename")
    args = parser.parse_args()
    try:
        print(json.dumps(publish(args.source, args.target, on_conflict=args.on_conflict), ensure_ascii=False))
    except (OSError, ValueError) as error:
        parser.exit(1, f"Could not save artifact: {error}\n")
