#!/usr/bin/env python3
"""Inspect APK lib/<abi>/*.so ELF load segments using only Python's stdlib.

This reports ELF layout, not successful execution on a 16 KB-page device.
Use Android's zipalign separately to verify ZIP entry alignment.
"""

import argparse
import json
from pathlib import Path
import struct
import sys
import zipfile
import zlib


PAGE_SIZE = 16384
PT_LOAD = 1
MACHINES = {3: "x86", 40: "ARM", 62: "x86_64", 183: "AArch64"}


def inspect_elf(data):
    if len(data) < 16 or data[:4] != b"\x7fELF":
        raise ValueError("Not an ELF file or ELF identification is truncated")
    elf_class, encoding = data[4], data[5]
    if elf_class not in (1, 2) or encoding not in (1, 2):
        raise ValueError("Unsupported ELF class or byte order")
    endian = "<" if encoding == 1 else ">"
    header_size = 52 if elf_class == 1 else 64
    if len(data) < header_size:
        raise ValueError("Truncated ELF header")
    if elf_class == 1:
        phoff = struct.unpack_from(endian + "I", data, 28)[0]
        phentsize, phnum = struct.unpack_from(endian + "HH", data, 42)
        phformat = endian + "IIIIIIII"
    else:
        phoff = struct.unpack_from(endian + "Q", data, 32)[0]
        phentsize, phnum = struct.unpack_from(endian + "HH", data, 54)
        phformat = endian + "IIQQQQQQ"
    if phnum == 0xFFFF:
        raise ValueError("Extended ELF program-header numbering is unsupported")
    if phnum and phentsize < struct.calcsize(phformat):
        raise ValueError("ELF program-header entries are too short")
    if phoff + phentsize * phnum > len(data):
        raise ValueError("ELF program-header table extends beyond the file")

    segments = []
    for index in range(phnum):
        values = struct.unpack_from(phformat, data, phoff + index * phentsize)
        if values[0] != PT_LOAD:
            continue
        if elf_class == 1:
            _, offset, vaddr, _, filesz, memsz, flags, alignment = values
        else:
            _, flags, offset, vaddr, _, filesz, memsz, alignment = values
        power_of_two = alignment > 0 and (alignment & (alignment - 1)) == 0
        enough_alignment = power_of_two and alignment >= PAGE_SIZE
        congruent = (vaddr - offset) % PAGE_SIZE == 0
        issues = []
        if not enough_alignment:
            issues.append("p_align must be a power of two at least 16384 bytes")
        if not congruent:
            issues.append("p_vaddr and p_offset differ modulo 16384 bytes")
        if power_of_two and (vaddr - offset) % alignment:
            issues.append("p_vaddr and p_offset violate the declared p_align")
        if filesz > memsz:
            issues.append("Malformed PT_LOAD: p_filesz exceeds p_memsz")
        if filesz and offset + filesz > len(data):
            issues.append("Malformed PT_LOAD: file-backed bytes extend beyond ELF")
        segments.append({
            "program_header_index": index,
            "file_offset": offset,
            "virtual_address": vaddr,
            "file_size": filesz,
            "memory_size": memsz,
            "flags": flags,
            "alignment_bytes": alignment,
            "alignment_power_of_two_and_at_least_16kb": enough_alignment,
            "file_offset_modulo_16kb": offset % PAGE_SIZE,
            "virtual_address_modulo_16kb": vaddr % PAGE_SIZE,
            "congruent_modulo_16kb": congruent,
            "issues": issues,
        })
    machine = struct.unpack_from(endian + "H", data, 18)[0]
    return {
        "elf_class_bits": 32 if elf_class == 1 else 64,
        "byte_order": "little" if encoding == 1 else "big",
        "machine": machine,
        "machine_name": MACHINES.get(machine, "unknown"),
        "program_header_count": phnum,
        "load_segments": segments,
        "passes_16kb_elf_layout": bool(segments) and all(
            not segment["issues"] for segment in segments
        ),
        "issues": [
            "PT_LOAD {}: {}".format(segment["program_header_index"], issue)
            for segment in segments for issue in segment["issues"]
        ] if segments else ["ELF contains no PT_LOAD segments"],
    }


def inspect_apk(apk):
    report = {
        "artifact": str(apk.resolve()),
        "page_size_bytes": PAGE_SIZE,
        "scope": "Only lib/<abi>/*.so; assets/ DSP binaries are excluded",
        "conditions": [
            "Every PT_LOAD p_align is a power of two and at least 16384 bytes",
            "Every PT_LOAD p_vaddr equals p_offset modulo 16384 bytes",
            "PT_LOAD also obeys declared p_align and file/memory bounds",
        ],
        "limitations": [
            "ELF layout does not prove successful execution on a device",
            "ZIP entry alignment, APK signatures and manifest minSdk are separate checks",
            "A 16 KB layout failure alone says nothing about the Android API 24 installation floor",
            "Native backend exports and DSP assets are checked by verify-android-payload.js",
        ],
        "abis": [],
        "libraries": [],
        "read_errors": [],
    }
    try:
        with zipfile.ZipFile(apk) as archive:
            report["abis"] = sorted({
                parts[1] for entry in archive.infolist()
                if len(parts := entry.filename.split("/")) >= 3
                and parts[0] == "lib" and parts[1]
            })
            seen = set()
            for entry in archive.infolist():
                parts = entry.filename.split("/")
                if len(parts) != 3 or parts[0] != "lib" or not parts[2].endswith(".so"):
                    continue
                library = {"entry": entry.filename, "abi": parts[1], "size_bytes": entry.file_size}
                try:
                    if entry.filename in seen:
                        raise ValueError("Duplicate native-library ZIP entry")
                    seen.add(entry.filename)
                    library.update(inspect_elf(archive.read(entry)))
                except (ValueError, OSError, RuntimeError, struct.error, zipfile.BadZipFile, zlib.error) as error:
                    library.update({"read_error": str(error), "passes_16kb_elf_layout": False})
                    report["read_errors"].append(entry.filename + ": " + str(error))
                report["libraries"].append(library)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        report["read_errors"].append(str(error))
    if not report["libraries"]:
        report["read_errors"].append("No lib/<abi>/*.so entries were inspected")
    report["libraries"].sort(key=lambda item: item["entry"])
    report["library_count"] = len(report["libraries"])
    report["failed_library_count"] = sum(
        not item["passes_16kb_elf_layout"] for item in report["libraries"]
    )
    report["status"] = (
        "unreadable" if report["read_errors"] else
        "fail" if report["failed_library_count"] else "pass"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--report", type=Path, help="Write detailed JSON here")
    parser.add_argument(
        "--require-16kb", action="store_true",
        help="Exit 1 if any PT_LOAD fails the exact conditions recorded in JSON",
    )
    args = parser.parse_args()
    report = inspect_apk(args.apk)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.report:
        args.report.write_text(rendered, encoding="utf-8")
        print("ELF layout: {status}; libraries={library_count}; failed={failed_library_count}".format(**report))
        print("Report: " + str(args.report.resolve()))
    else:
        sys.stdout.write(rendered)
    if report["read_errors"]:
        return 2
    return 1 if args.require_16kb and report["status"] == "fail" else 0


if __name__ == "__main__":
    sys.exit(main())
